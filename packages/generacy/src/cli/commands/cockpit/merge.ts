import { Command } from 'commander';
import type { Logger } from 'pino';
import type { GhWrapper, PullRequestDetail } from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';
import { resolveIssueContext } from './resolver.js';
import { classifyChecks } from './shared/required-checks.js';
import {
  buildFailingCheckPayload,
  serializeFailingCheckJson,
  type IssueRefWithState,
} from './shared/failing-check-json.js';

// Workflow labels (`waiting-for:*`, `completed:*`) are issue-scoped per the
// #807-Q2 label protocol. runMerge reads `completed:validate` from
// IssueStateResult.labels, never from PullRequestDetail.labels.
const COMPLETED_VALIDATE_LABEL = 'completed:validate';

export interface RunMergeInput {
  gh: GhWrapper;
  issue: number;
  repo: string;
  logger: Logger;
}

export interface RunMergeResult {
  exitCode: 0 | 1;
  stdout: string;
}

function parseIssueRef(repo: string, issue: number): IssueRefWithState {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(
      `runMerge: repo must be "owner/name", got: ${repo}`,
    );
  }
  return { owner, repo: name, number: issue };
}

interface DeletionCtx {
  gh: GhWrapper;
  pr: PullRequestDetail;
  issueRef: IssueRefWithState;
  logger: Logger;
}

async function classifyAndDeleteBranch(ctx: DeletionCtx): Promise<string> {
  const { gh, pr, issueRef, logger } = ctx;

  if (
    pr.headRepositoryOwner != null &&
    pr.headRepositoryOwner !== issueRef.owner
  ) {
    logger.info(
      { pr: pr.number, headRef: pr.head, headOwner: pr.headRepositoryOwner },
      'branch deletion skipped: cross-fork PR',
    );
    return 'merged (branch delete skipped: cross-fork PR)\n';
  }

  const repo = `${issueRef.owner}/${issueRef.repo}`;
  const result = await gh.deleteHeadRef(repo, pr.head);
  switch (result.outcome) {
    case 'deleted':
      return 'merged and branch deleted\n';
    case 'already-gone':
      logger.info(
        { pr: pr.number, headRef: pr.head },
        'branch was already deleted',
      );
      return 'merged (branch was already deleted)\n';
    case 'delete-failed':
      logger.warn(
        { pr: pr.number, repo, headRef: pr.head, stderr: result.stderr },
        'branch deletion failed',
      );
      return `merged (branch delete failed: ${result.stderr ?? ''})\n`;
  }
}

export async function runMerge(input: RunMergeInput): Promise<RunMergeResult> {
  const { gh, issue, repo, logger } = input;
  const issueRef = parseIssueRef(repo, issue);

  const prRef = await gh.resolveIssueToPRRef(repo, issue);
  if (prRef == null) {
    logger.error({ issue, repo }, 'No PR resolved for issue');
    return {
      exitCode: 1,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'unresolved',
          pr: null,
          issue: issueRef,
        }),
      ),
    };
  }
  if (prRef.state !== 'OPEN') {
    logger.error(
      { issue, repo, pr: prRef.number, state: prRef.state },
      'PR is not OPEN',
    );
    return {
      exitCode: 1,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'unresolved',
          pr: { number: prRef.number, url: prRef.url },
          issue: issueRef,
        }),
      ),
    };
  }

  const pr = await gh.getPullRequestDetail(repo, prRef.number);

  let issueState;
  try {
    issueState = await gh.fetchIssueState(repo, issue);
  } catch (err) {
    logger.error({ issue, repo, err }, 'Failed to fetch issue state');
    return {
      exitCode: 1,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'unresolved',
          pr: null,
          issue: issueRef,
        }),
      ),
    };
  }

  if (issueState.state === 'CLOSED') {
    logger.error(
      {
        issue,
        repo,
        state: issueState.state,
        stateReason: issueState.stateReason,
      },
      'Issue is CLOSED',
    );
    return {
      exitCode: 1,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'unresolved',
          pr: { number: pr.number, url: pr.url },
          issue: {
            ...issueRef,
            state: issueState.state,
            stateReason: issueState.stateReason,
          },
        }),
      ),
    };
  }

  if (!issueState.labels.includes(COMPLETED_VALIDATE_LABEL)) {
    logger.error(
      { issue, repo, missingLabel: COMPLETED_VALIDATE_LABEL },
      'Issue missing completed:validate label',
    );
    return {
      exitCode: 1,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'missing-label',
          pr: { number: pr.number, url: pr.url },
          issue: issueRef,
        }),
      ),
    };
  }

  const [required, actualChecks] = await Promise.all([
    gh.getRequiredCheckNames(repo, pr.base),
    gh.getPullRequestCheckRuns(repo, pr.number),
  ]);

  if (required.source === 'fallback-pr-checks') {
    logger.warn(
      'required-check set derived from PR check list; token cannot read branch protection',
    );
  }

  const noActual = actualChecks.length === 0;
  const noRequired =
    required.source === 'branch-protection'
      ? (required.names?.length ?? 0) === 0
      : true;
  if (noActual && noRequired) {
    await gh.mergePullRequest(repo, pr.number, { squash: true });
    logger.info({ pr: pr.number }, 'PR merged');
    const deletionSuffix = await classifyAndDeleteBranch({
      gh,
      pr,
      issueRef,
      logger,
    });
    return {
      exitCode: 0,
      stdout:
        'no checks configured and none required — proceeding on completed:validate\n' +
        deletionSuffix,
    };
  }

  const { failingChecks, ok } = classifyChecks({ required, actual: actualChecks });
  if (!ok) {
    logger.error(
      { pr: pr.number, failing: failingChecks.length },
      'PR has failing or pending required checks',
    );
    return {
      exitCode: 1,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'checks-failing',
          pr: { number: pr.number, url: pr.url },
          failingChecks,
          issue: issueRef,
        }),
      ),
    };
  }

  await gh.mergePullRequest(repo, pr.number, { squash: true });
  logger.info({ pr: pr.number }, 'PR merged');
  const deletionSuffix = await classifyAndDeleteBranch({
    gh,
    pr,
    issueRef,
    logger,
  });
  return { exitCode: 0, stdout: deletionSuffix };
}

export function cockpitMergeCommand(): Command {
  const cmd = new Command('merge');
  cmd
    .description(
      'Squash-merge the PR for <issue> iff it carries completed:validate and every required check is green',
    )
    .argument('<issue>', 'GitHub issue number')
    .option('--repo <repo>', 'Owner/name (inferred from cwd if absent)')
    .action(async (issueArg: string, opts: { repo?: string }) => {
      const logger = getLogger();
      const ctx = await resolveIssueContext({ issue: issueArg, repo: opts.repo });
      const result = await runMerge({
        gh: ctx.gh,
        issue: ctx.ref.number,
        repo: ctx.repo,
        logger,
      });
      if (result.stdout.length > 0) {
        process.stdout.write(result.stdout);
      }
      process.exit(result.exitCode);
    });
  return cmd;
}
