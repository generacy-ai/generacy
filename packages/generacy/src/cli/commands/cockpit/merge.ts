import { Command } from 'commander';
import type { Logger } from 'pino';
import type { GhWrapper } from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';
import { resolveContext } from './shared/resolve-context.js';
import { classifyChecks } from './shared/required-checks.js';
import {
  buildFailingCheckPayload,
  serializeFailingCheckJson,
} from './shared/failing-check-json.js';

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

export async function runMerge(input: RunMergeInput): Promise<RunMergeResult> {
  const { gh, issue, repo, logger } = input;

  const prRef = await gh.resolveIssueToPRRef(repo, issue);
  if (prRef == null) {
    logger.error({ issue, repo }, 'No PR resolved for issue');
    return {
      exitCode: 1,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({ reason: 'unresolved', pr: null }),
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
        }),
      ),
    };
  }

  const pr = await gh.getPullRequestDetail(repo, prRef.number);
  if (!pr.labels.includes(COMPLETED_VALIDATE_LABEL)) {
    logger.error(
      { pr: pr.number, missingLabel: COMPLETED_VALIDATE_LABEL },
      'PR missing completed:validate label',
    );
    return {
      exitCode: 1,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'missing-label',
          pr: { number: pr.number, url: pr.url },
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
        }),
      ),
    };
  }

  await gh.mergePullRequest(repo, pr.number, { squash: true });
  logger.info({ pr: pr.number }, 'PR merged');
  return { exitCode: 0, stdout: '' };
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
      const issue = Number.parseInt(issueArg, 10);
      if (!Number.isInteger(issue) || issue <= 0) {
        throw new Error(`Invalid issue number: ${issueArg}`);
      }
      const logger = getLogger();
      const ctx = await resolveContext({ issue, repo: opts.repo });
      const result = await runMerge({
        gh: ctx.gh,
        issue: ctx.issue,
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
