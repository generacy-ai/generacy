import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubClient } from '@generacy-ai/workflow-engine';

const execFileAsync = promisify(execFile);

/**
 * Input for `evaluatePushGuard`.
 *
 * `github` is `Pick<GitHubClient, ...>` — the guard only needs
 * `findPRForBranchAnyState`. Callers can inject a full GitHubClient or a
 * narrower stub in tests.
 *
 * `git.remoteBranchExists` is injected so tests do not have to spawn a real
 * `git ls-remote`. Production callers omit it and get the default helper
 * exported from this module.
 */
export interface PushGuardInput {
  owner: string;
  repo: string;
  issueNumber: number;
  branch: string;
  github: Pick<GitHubClient, 'findPRForBranchAnyState'>;
  git: {
    remoteBranchExists(branch: string): Promise<boolean>;
  };
}

/**
 * Guard decision. See `push-guard.md` § Semantics for the full matrix.
 *
 * - `allow` — proceed with the push.
 * - `refuse` — caller MUST NOT push. `reason` names the diagnostic cause;
 *   `prNumber` is present when a PR was found, `null` for the no-PR case.
 */
export type PushGuardDecision =
  | { kind: 'allow' }
  | {
      kind: 'refuse';
      reason: 'pr-merged' | 'pr-closed' | 'branch-missing';
      prNumber: number | null;
      branch: string;
      owner: string;
      repo: string;
      issueNumber: number;
    };

/**
 * Default `git.remoteBranchExists` helper for production callers.
 *
 * Runs `git ls-remote --heads origin <branch>` in the process's current cwd.
 * Callers that need to run against a specific checkout should inject their
 * own implementation. Uses the same idiom as `GhCliGitHubClient.branchExists(
 * branch, true)` at `gh-cli.ts:1094-1097`.
 */
export async function defaultRemoteBranchExists(
  branch: string,
  cwd?: string,
): Promise<boolean> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-remote', '--heads', 'origin', branch],
    cwd ? { cwd, encoding: 'utf-8' } : { encoding: 'utf-8' },
  );
  return stdout.trim() !== '';
}

/**
 * Stateless pre-push guard used by `pr-feedback-handler`, `pr-manager`, and
 * `phase-loop` per #1051 FR-002.
 *
 * Runs two lookups in parallel — the PR state across all states and the
 * remote-branch existence check — then applies the decision matrix in
 * `push-guard.md`. If either lookup throws, the guard returns `allow`
 * (fail open — FR-001 and FR-004 are the correctness gates; this guard is
 * the anomaly detector, not the correctness gate).
 *
 * The guard emits NO logs on its own. Callers are responsible for the
 * `event: 'push-refused'` warn line so the log is at the site that took
 * action, not the site that computed the decision (SC-002 asserts exactly
 * one refusal log per refusal).
 */
export async function evaluatePushGuard(input: PushGuardInput): Promise<PushGuardDecision> {
  const { owner, repo, branch, issueNumber, github, git } = input;

  let pr: Awaited<ReturnType<GitHubClient['findPRForBranchAnyState']>>;
  let branchPresent: boolean;
  try {
    [pr, branchPresent] = await Promise.all([
      github.findPRForBranchAnyState(owner, repo, branch),
      git.remoteBranchExists(branch),
    ]);
  } catch {
    // Failure isolation (contract § Failure isolation). A transient `gh` or
    // `git` failure must not block a legitimate push. Refusal path is the
    // anomaly detector, not the correctness gate.
    return { kind: 'allow' };
  }

  // Row 1: PR merged → refuse. Short-circuits row 3 so a merged PR whose
  // branch was deleted still produces the more diagnostic `pr-merged` reason.
  if (pr && pr.state === 'merged') {
    return {
      kind: 'refuse',
      reason: 'pr-merged',
      prNumber: pr.number,
      branch,
      owner,
      repo,
      issueNumber,
    };
  }

  // Row 2: PR closed (non-merged) → refuse.
  if (pr && pr.state === 'closed') {
    return {
      kind: 'refuse',
      reason: 'pr-closed',
      prNumber: pr.number,
      branch,
      owner,
      repo,
      issueNumber,
    };
  }

  // Row 3 / Row 5: branch missing on remote. Both open-PR and no-PR cases
  // fall through here.
  if (!branchPresent) {
    return {
      kind: 'refuse',
      reason: 'branch-missing',
      prNumber: pr ? pr.number : null,
      branch,
      owner,
      repo,
      issueNumber,
    };
  }

  // Rows 4 + 6: branch present + (open PR or no PR) → allow. First-push case
  // (no PR yet) explicitly falls under `allow` per Q2 clarification.
  return { kind: 'allow' };
}
