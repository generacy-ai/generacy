/**
 * Sibling fan-out handler — phase:after hook for cross-repo change propagation.
 *
 * After each workflow phase, detects changes in sibling repos, commits them
 * to a matching branch, pushes, and opens draft PRs with cross-repo
 * `Closes generacy-ai/<primary-repo>#<issue>` references.
 */
import type { GitHubClient, GitStatus } from '../actions/github/client/interface.js';
import type { WorkflowState, WorkflowStore, LinkedPR } from '../types/store.js';
import type { Logger } from '../types/logger.js';
import { GhCliGitHubClient } from '../actions/github/client/gh-cli.js';
import { addLinkedPR } from '../store/linked-pr.js';

/**
 * Context provided to the sibling fan-out handler.
 */
export interface SiblingFanoutContext {
  /** Absolute path to the primary repository working directory */
  primaryWorkdir: string;
  /** Map of sibling repo name → absolute path */
  siblingWorkdirs: Record<string, string>;
  /** Issue number from the phase-loop context */
  issueNumber: number;
  /** Primary repo short name (e.g. "generacy") */
  primaryRepoName: string;
  /** GitHub org (e.g. "generacy-ai") */
  org: string;
  /** Workflow store for persisting linkedPRs */
  workflowStore: WorkflowStore;
  /** Current workflow state (read for linkedPRs, written back after updates) */
  workflowState: WorkflowState;
  /** Logger instance */
  logger: Logger;
  /** Optional GitHub token provider (follows #620 pattern) */
  tokenProvider?: () => Promise<string | undefined>;
}

/**
 * Outcome for a single sibling that was processed.
 */
export interface SiblingOutcome {
  /** Sibling repo name */
  repo: string;
  /** Branch name used */
  branch: string;
  /** PR number (newly created or existing) */
  prNumber: number;
  /** Full PR URL */
  prUrl: string;
  /** Whether the PR was newly created or already existed */
  prCreated: boolean;
}

/**
 * Result from the sibling fan-out handler.
 */
export interface SiblingFanoutResult {
  /** Siblings that were processed (had changes) */
  processed: SiblingOutcome[];
  /** Siblings that were skipped (no changes) */
  skipped: string[];
}

/**
 * Fetch the primary PR title, falling back to issue-based title.
 */
async function getPrimaryPRTitle(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
  issueNumber: number,
): Promise<string> {
  try {
    const pr = await client.findPRForBranch(owner, repo, branch);
    if (pr?.title) return pr.title;
  } catch {
    // PR lookup failed — use fallback
  }
  return `[Multi-repo] Issue #${issueNumber}`;
}

/**
 * Fetch the primary repo's last commit message.
 */
async function getLastCommitMessage(workdir: string): Promise<string> {
  const { executeCommand } = await import('../actions/cli-utils.js');
  const result = await executeCommand(
    'git', ['log', '-1', '--format=%s'],
    { cwd: workdir },
  );
  return result.stdout.trim() || 'chore: sync sibling repo changes';
}

/**
 * Process a single sibling repo — branch, commit, push, PR.
 */
async function processSibling(
  siblingName: string,
  siblingWorkdir: string,
  ctx: SiblingFanoutContext,
  primaryBranch: string,
  primaryPRTitle: string,
  commitMessage: string,
): Promise<SiblingOutcome> {
  const client = new GhCliGitHubClient(siblingWorkdir, ctx.tokenProvider);

  // Branch — check remote first (may exist from a previous partial run)
  const remoteExists = await client.branchExists(primaryBranch, true);
  if (remoteExists) {
    // Fetch and checkout existing remote branch
    await client.fetch('origin');
    try {
      await client.checkout(primaryBranch);
    } catch {
      // May need to create local tracking branch
      await client.createBranch(primaryBranch, `origin/${primaryBranch}`);
    }
  } else {
    const localExists = await client.branchExists(primaryBranch, false);
    if (localExists) {
      await client.checkout(primaryBranch);
    } else {
      const defaultBranch = await client.getDefaultBranch();
      await client.createBranch(primaryBranch, defaultBranch);
    }
  }

  // Stage all + commit (if there are unstaged/untracked changes)
  const statusAfterCheckout = await client.getStatus();
  if (statusAfterCheckout.has_changes) {
    await client.stageAll();
    await client.commit(commitMessage);
  }

  // Push
  await client.push('origin', primaryBranch, true);

  // Check for existing PR
  const existingPR = await client.findPRForBranch(ctx.org, siblingName, primaryBranch);

  let prNumber: number;
  let prUrl: string;
  let prCreated: boolean;

  if (existingPR) {
    prNumber = existingPR.number;
    prUrl = `https://github.com/${ctx.org}/${siblingName}/pull/${existingPR.number}`;
    prCreated = false;
  } else {
    // Create draft PR with cross-repo close reference
    const defaultBranch = await client.getDefaultBranch();
    const pr = await client.createPullRequest(ctx.org, siblingName, {
      title: primaryPRTitle,
      body: `Closes ${ctx.org}/${ctx.primaryRepoName}#${ctx.issueNumber}`,
      head: primaryBranch,
      base: defaultBranch,
      draft: true,
    });
    prNumber = pr.number;
    prUrl = `https://github.com/${ctx.org}/${siblingName}/pull/${pr.number}`;
    prCreated = true;
  }

  return { repo: siblingName, branch: primaryBranch, prNumber, prUrl, prCreated };
}

/**
 * Sibling fan-out handler — runs after each workflow phase.
 *
 * Detects changes in sibling repositories, commits them to a matching branch,
 * pushes, and opens draft PRs with cross-repo `Closes` references.
 *
 * Short-circuits when `siblingWorkdirs` is empty or all siblings are clean.
 */
export async function siblingFanoutHandler(ctx: SiblingFanoutContext): Promise<SiblingFanoutResult> {
  const result: SiblingFanoutResult = { processed: [], skipped: [] };

  // Short-circuit: no siblings
  const siblingEntries = Object.entries(ctx.siblingWorkdirs);
  if (siblingEntries.length === 0) {
    ctx.logger.debug('sibling-fanout: no siblings configured, skipping');
    return result;
  }

  // Detect which siblings have changes
  const siblingsWithChanges: Array<{ name: string; workdir: string; status: GitStatus }> = [];

  for (const [name, workdir] of siblingEntries) {
    try {
      const client = new GhCliGitHubClient(workdir, ctx.tokenProvider);
      const status = await client.getStatus();

      if (status.has_changes || status.hasUnpushed) {
        siblingsWithChanges.push({ name, workdir, status });
      } else {
        result.skipped.push(name);
      }
    } catch (err) {
      // Detection failure — log and skip this sibling
      ctx.logger.warn(
        `sibling-fanout: failed to detect changes in ${name}: ${err instanceof Error ? err.message : String(err)}`
      );
      result.skipped.push(name);
    }
  }

  // Short-circuit: all siblings clean
  if (siblingsWithChanges.length === 0) {
    ctx.logger.debug('sibling-fanout: all siblings clean, skipping');
    return result;
  }

  // Source context from primary repo
  const primaryClient = new GhCliGitHubClient(ctx.primaryWorkdir, ctx.tokenProvider);
  const primaryStatus = await primaryClient.getStatus();
  const primaryBranch = primaryStatus.branch;

  if (!primaryBranch) {
    throw new Error('sibling-fanout: primary repo is in detached HEAD state');
  }

  const primaryPRTitle = await getPrimaryPRTitle(
    primaryClient, ctx.org, ctx.primaryRepoName, primaryBranch, ctx.issueNumber,
  );
  const commitMessage = await getLastCommitMessage(ctx.primaryWorkdir);

  // Process each sibling sequentially
  let currentState = ctx.workflowState;
  for (const sibling of siblingsWithChanges) {
    const outcome = await processSibling(
      sibling.name, sibling.workdir, ctx,
      primaryBranch, primaryPRTitle, commitMessage,
    );

    result.processed.push(outcome);

    // Persist linked PR
    const linkedPR: LinkedPR = {
      repo: outcome.repo,
      number: outcome.prNumber,
      branch: outcome.branch,
      url: outcome.prUrl,
    };
    currentState = addLinkedPR(currentState, linkedPR);
    await ctx.workflowStore.save(currentState);

    ctx.logger.info(
      `sibling-fanout: ${outcome.repo} — ${outcome.prCreated ? 'created' : 'reused'} PR #${outcome.prNumber}`,
    );
  }

  return result;
}
