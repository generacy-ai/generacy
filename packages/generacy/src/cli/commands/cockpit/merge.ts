import { Command } from 'commander';
import type { Logger } from 'pino';
import type {
  GhWrapper,
  LinkMethod,
  PullRequestDetail,
  PullRequestRef,
} from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';
import { CockpitExit } from './exit.js';
import { resolveIssueContext } from './resolver.js';
import { classifyChecks } from './shared/required-checks.js';
import {
  buildFailingCheckPayload,
  serializeFailingCheckJson,
  type IssueRefWithState,
} from './shared/failing-check-json.js';

function toPrCandidates(refs: PullRequestRef[]): Array<{
  number: number;
  url: string;
  isDraft: boolean;
  headRefName: string;
}> {
  return refs.map((r) => ({
    number: r.number,
    url: r.url,
    isDraft: r.draft,
    headRefName: r.headRefName,
  }));
}

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
  exitCode: 0 | 1 | 2 | 3;
  stdout: string;
  /**
   * #928 — the PR number the CLI operated on. Set on exit-0 (the PR that was
   * merged), on the pr-flag paths (mirrors the caller's `--pr <n>`), and on
   * the resolver's non-terminal red paths where a PR was identified. Absent
   * on `unresolved` / `pr-number` (no PR to name).
   */
  prNumber?: number;
}

export interface RunMergeWithExplicitPrInput {
  gh: GhWrapper;
  /** The `<ref>` issue number — authorization source for `completed:validate`. */
  issue: number;
  repo: string;
  /** The operator-supplied `--pr <number>` value. Positive integer, validated. */
  prNumber: number;
  logger: Logger;
}

/**
 * FR-005 — Commander parser for `--pr <number>`. See contracts/pr-flag-cli.md §2.
 * Throws `CockpitExit(2)` on any malformed input.
 */
export function parsePrFlag(input: string): number {
  const trimmed = input.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
    throw new CockpitExit(
      2,
      `merge: --pr must be a positive integer, got: "${input}"`,
    );
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CockpitExit(
      2,
      `merge: --pr must be a positive integer, got: "${input}"`,
    );
  }
  return n;
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

/**
 * `exitPolicy` — chosen by caller to preserve the sanctioned path's exit-1
 * legacy behavior while giving the `--pr` path exit-3 semantics per FR-008.
 * See contracts/pr-flag-cli.md §5.
 */
type ExitPolicy = 'resolver' | 'pr-flag';

interface AssertCompletedValidateAndMergeInput {
  gh: GhWrapper;
  repo: string;
  issue: number;
  issueRef: IssueRefWithState;
  prNumber: number;
  logger: Logger;
  exitPolicy: ExitPolicy;
  /** Present on resolver-driven path (for logging + payload); absent on `--pr`. */
  linkMethod?: LinkMethod;
}

/**
 * Shared merge-tail helper. Fetches issue state, checks completed:validate,
 * fetches required checks, classifies, merges, deletes branch. Extracted from
 * runMerge for reuse by runMergeWithExplicitPr per contracts/pr-flag-cli.md §5.
 */
async function assertCompletedValidateAndMerge(
  input: AssertCompletedValidateAndMergeInput,
): Promise<RunMergeResult> {
  const {
    gh,
    repo,
    issue,
    issueRef,
    prNumber,
    logger,
    exitPolicy,
    linkMethod,
  } = input;
  const refuseExit: 1 | 3 = exitPolicy === 'pr-flag' ? 3 : 1;

  const pr = await gh.getPullRequestDetail(repo, prNumber);

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
      exitCode: refuseExit,
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
    const prPayload: { number: number; url: string; linkMethod?: LinkMethod } =
      linkMethod !== undefined
        ? { number: pr.number, url: pr.url, linkMethod }
        : // `missing-label` builder invariant I-9 requires linkMethod. Use the
          // dedicated pr-flag `missing-label` payload variant: since the shared
          // builder requires linkMethod for `missing-label`, we synthesize a
          // sentinel for the pr-flag path so both share the schema shape.
          { number: pr.number, url: pr.url, linkMethod: 'closing-refs' };
    return {
      exitCode: refuseExit,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'missing-label',
          pr: prPayload,
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
      prNumber: pr.number,
    };
  }

  const { failingChecks, ok } = classifyChecks({ required, actual: actualChecks });
  if (!ok) {
    logger.error(
      { pr: pr.number, failing: failingChecks.length },
      'PR has failing or pending required checks',
    );
    const prPayload: { number: number; url: string; linkMethod?: LinkMethod } =
      linkMethod !== undefined
        ? { number: pr.number, url: pr.url, linkMethod }
        : { number: pr.number, url: pr.url, linkMethod: 'closing-refs' };
    return {
      exitCode: refuseExit,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'checks-failing',
          pr: prPayload,
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
  return { exitCode: 0, stdout: deletionSuffix, prNumber: pr.number };
}

export async function runMerge(input: RunMergeInput): Promise<RunMergeResult> {
  const { gh, issue, repo, logger } = input;
  const issueRef = parseIssueRef(repo, issue);

  const resolution = await gh.resolveIssueToPRRef(repo, issue);
  if (resolution.kind === 'unresolved') {
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
  // #928 — the caller's `<issue>` argument is itself a PR node. Emit a
  // typed refusal at exit-2 with guidance copy; the MCP envelope maps this
  // reason to `class: 'wrong-kind'`. Closes #906 on the CLI at the same time.
  if (resolution.kind === 'pr-number') {
    logger.error(
      { issue, repo },
      `#${issue} is a pull request, not an issue`,
    );
    return {
      exitCode: 2,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'pr-number',
          pr: null,
          issue: issueRef,
          hint:
            `#${issue} is a pull request; pass the issue number ` +
            `(e.g. the issue whose closing PR is #${issue}).`,
        }),
      ),
    };
  }
  if (resolution.kind === 'pr-is-draft') {
    logger.error(
      {
        issue,
        repo,
        linkMethod: resolution.linkMethod,
        candidates: resolution.candidates.map((c) => c.number),
      },
      'Resolved PRs are drafts',
    );
    return {
      exitCode: 1,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'pr-is-draft',
          pr: null,
          candidates: toPrCandidates(resolution.candidates),
          linkMethod: resolution.linkMethod,
          issue: issueRef,
        }),
      ),
    };
  }
  if (resolution.kind === 'ambiguous') {
    logger.error(
      {
        issue,
        repo,
        linkMethod: resolution.linkMethod,
        candidates: resolution.candidates.map((c) => c.number),
      },
      'Multiple PRs resolved for issue',
    );
    return {
      exitCode: 1,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'ambiguous-resolution',
          pr: null,
          candidates: toPrCandidates(resolution.candidates),
          linkMethod: resolution.linkMethod,
          issue: issueRef,
        }),
      ),
    };
  }
  // Exhaustiveness guard — after the branches above, resolution.kind is
  // 'resolved'. Adding a new arm to PullRequestRefResolution surfaces here
  // at build time.
  const _exhaustive: 'resolved' = resolution.kind;
  void _exhaustive;
  const prRef: PullRequestRef = resolution.ref;
  const linkMethod: LinkMethod = resolution.linkMethod;
  // FR-004: log the resolved PR + tier BEFORE any subsequent gh call so a
  // later failure never erases the evidence of which PR was targeted.
  logger.info(
    { pr: prRef.number, linkMethod },
    `resolved PR #${prRef.number} via ${linkMethod}`,
  );

  return assertCompletedValidateAndMerge({
    gh,
    repo,
    issue,
    issueRef,
    prNumber: prRef.number,
    logger,
    exitPolicy: 'resolver',
    linkMethod,
  });
}

/**
 * FR-005..FR-008 — `--pr <number>` escape hatch. Skips the tier-1/2/3 resolver
 * chain but keeps every safety precondition. Gate order per contracts/pr-flag-cli.md §3.
 */
export async function runMergeWithExplicitPr(
  input: RunMergeWithExplicitPrInput,
): Promise<RunMergeResult> {
  const { gh, issue, repo, prNumber, logger } = input;
  const issueRef = parseIssueRef(repo, issue);

  const pr = await gh.getPullRequestGraphqlDetail(repo, prNumber);

  // Gate 1 — FR-006a linkage.
  const declares = pr.closingIssuesReferences.some(
    (l) => l.nameWithOwner === repo && l.number === issue,
  );
  if (!declares) {
    const kind =
      pr.closingIssuesReferences.length === 0 ? 'empty-refs' : 'mismatch';
    const message =
      kind === 'empty-refs'
        ? `--pr ${prNumber} refused: PR #${prNumber} declares no closing issues. Add ${repo}#${issue} via the PR's Development sidebar link, then re-run.`
        : `--pr ${prNumber} refused: PR #${prNumber} does not declare ${repo}#${issue} as a closing issue. Add ${repo}#${issue} via the PR's Development sidebar link, then re-run.`;
    logger.error(
      { pr: prNumber, issue, repo, kind },
      `--pr linkage refused: ${kind}`,
    );
    return {
      exitCode: 3,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'pr-flag-linkage-refused',
          pr: { number: prNumber, url: '' },
          kind,
          message,
          issue: issueRef,
        }),
      ),
    };
  }

  // Gate 2 — FR-006b state classifier.
  if (pr.state === 'MERGED') {
    logger.info({ pr: prNumber }, `PR #${prNumber} already merged, no-op`);
    return {
      exitCode: 0,
      stdout: `PR #${prNumber} already merged, no-op\n`,
      prNumber,
    };
  }
  if (pr.state === 'CLOSED') {
    logger.error({ pr: prNumber }, 'PR is closed without merge');
    return {
      exitCode: 3,
      stdout: serializeFailingCheckJson(
        buildFailingCheckPayload({
          reason: 'pr-flag-closed-unmerged',
          pr: { number: prNumber, url: '' },
          message: `--pr ${prNumber} refused: PR #${prNumber} is closed without merge.`,
          issue: issueRef,
        }),
      ),
    };
  }
  // state === 'OPEN' → continue.

  // Gates 3 & 4 — delegate to shared tail with pr-flag exitPolicy.
  return assertCompletedValidateAndMerge({
    gh,
    repo,
    issue,
    issueRef,
    prNumber,
    logger,
    exitPolicy: 'pr-flag',
  });
}

export function cockpitMergeCommand(): Command {
  const cmd = new Command('merge');
  cmd
    .description(
      'Squash-merge the PR for <issue> iff it carries completed:validate and every required check is green',
    )
    .argument('<issue>', 'GitHub issue number')
    .option('--repo <repo>', 'Owner/name (inferred from cwd if absent)')
    .option(
      '--pr <number>',
      'Escape hatch — target this PR directly, skipping issue→PR resolution. ' +
        '<issue> remains required as the authorization source for completed:validate. ' +
        'Enforces linkage verification and all safety preconditions; never bypasses safety.',
      parsePrFlag,
    )
    .action(
      async (issueArg: string, opts: { repo?: string; pr?: number }) => {
        const logger = getLogger();
        const ctx = await resolveIssueContext({
          issue: issueArg,
          repo: opts.repo,
        });
        const result =
          opts.pr != null
            ? await runMergeWithExplicitPr({
                gh: ctx.gh,
                issue: ctx.ref.number,
                repo: ctx.repo,
                prNumber: opts.pr,
                logger,
              })
            : await runMerge({
                gh: ctx.gh,
                issue: ctx.ref.number,
                repo: ctx.repo,
                logger,
              });
        if (result.stdout.length > 0) {
          process.stdout.write(result.stdout);
        }
        process.exit(result.exitCode);
      },
    );
  return cmd;
}
