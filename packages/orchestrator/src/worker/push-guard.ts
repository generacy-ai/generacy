import type { GitHubClient } from '@generacy-ai/workflow-engine';

/**
 * Input for `evaluatePushGuard`.
 *
 * `github` is `Pick<GitHubClient, ...>` — the guard only needs
 * `findPRForBranchAnyState`. Callers can inject a full GitHubClient or a
 * narrower stub in tests.
 *
 * `git.remoteBranchExists` is injected so tests do not have to spawn a real
 * `git ls-remote`. Production callers pass `defaultRemoteBranchExists` from
 * `./repo-checkout.js` — this module deliberately holds no `node:child_process`
 * import so the pure decision logic stays inside the repo-wide
 * `no-restricted-imports` ban (#437) without needing an allowlist entry.
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
 *
 * `pr-lookup-failed` (PR #1052 review Finding 4): the PR-state lookup threw
 * (e.g. `gh` rate limit, network blip, auth expiry). Distinct from
 * `branch-missing` etc. so operators can tell "safety gate could not
 * verify" from "safety gate confirmed a resurrection attempt". `prNumber`
 * is `null` (unknown).
 */
export type PushGuardDecision =
  | { kind: 'allow' }
  | {
      kind: 'refuse';
      reason: 'pr-merged' | 'pr-closed' | 'branch-missing' | 'pr-lookup-failed';
      prNumber: number | null;
      branch: string;
      owner: string;
      repo: string;
      issueNumber: number;
    };

/**
 * Stateless pre-push guard used by `pr-feedback-handler`, `pr-manager`, and
 * `phase-loop` per #1051 FR-002.
 *
 * Runs two lookups in parallel — the PR state across all states and the
 * remote-branch existence check — then applies the decision matrix in
 * `push-guard.md`. Per-lookup failure isolation (PR #1052 review Finding 4):
 *
 * - `github.findPRForBranchAnyState` throws → refuse with reason
 *   `'pr-lookup-failed'`. The guard cannot verify PR state, so it MUST NOT
 *   silently permit the push (a rate-limited `gh` call previously collapsed
 *   to `null` and reclassified as "no PR ever" → guard allowed a merged-PR
 *   resurrection push). Refuse-safe, not fail-open. FR-001's `--prune` is a
 *   defense in depth but does not fire when the branch is retained.
 * - `git.remoteBranchExists` throws → treated as `true` (present). Ownership
 *   of the ls-remote error case can only mislead in the resurrection
 *   direction if PR-state is also missing; PR-state is the load-bearing
 *   lookup and is now refuse-safe on error. Silent-failure guard for
 *   local-git transients continues per pre-Finding-4 behavior.
 *
 * The guard emits NO logs on its own. Callers are responsible for the
 * `event: 'push-refused'` warn line so the log is at the site that took
 * action, not the site that computed the decision (SC-002 asserts exactly
 * one refusal log per refusal).
 */
export async function evaluatePushGuard(input: PushGuardInput): Promise<PushGuardDecision> {
  const { owner, repo, branch, issueNumber, github, git } = input;

  // PR #1052 review Finding 4: split fail-isolation per lookup so a `gh`
  // failure does not silently reclassify as "no PR". Kick both lookups off
  // in parallel and await individually so one failure does not cancel the
  // other's result. PR #1052 review Round 3 Finding 1: wrap each invocation
  // in `Promise.resolve().then(...)` so a SYNCHRONOUS throw at the call site
  // (e.g. a `GitHubClient` implementation that lacks the method, or one that
  // validates arguments before returning a promise) surfaces as a promise
  // rejection the per-lookup `try` catches — instead of escaping the guard
  // entirely and crashing the phase loop.
  const prPromise = Promise.resolve().then(() => github.findPRForBranchAnyState(owner, repo, branch));
  const branchPromise = Promise.resolve().then(() => git.remoteBranchExists(branch));

  let pr: Awaited<typeof prPromise>;
  try {
    pr = await prPromise;
  } catch {
    // Drain the branch-existence promise so it does not raise an unhandled
    // rejection.
    await branchPromise.catch(() => undefined);
    return {
      kind: 'refuse',
      reason: 'pr-lookup-failed',
      prNumber: null,
      branch,
      owner,
      repo,
      issueNumber,
    };
  }

  let branchPresent: boolean;
  try {
    branchPresent = await branchPromise;
  } catch {
    // Fail-open on local-git ls-remote transient — the PR-state lookup
    // already succeeded, so if the state itself is `merged` / `closed`
    // rows 1-2 still refuse regardless of the branch-present outcome. Treat
    // as `true` so row 3 does not incorrectly refuse an open PR.
    branchPresent = true;
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

  // Row 3: PR open + branch missing → refuse (branch was deleted while a
  // legitimate PR is still open — a resurrection push would recreate it).
  if (pr && pr.state === 'open' && !branchPresent) {
    return {
      kind: 'refuse',
      reason: 'branch-missing',
      prNumber: pr.number,
      branch,
      owner,
      repo,
      issueNumber,
    };
  }

  // Row 4: PR open + branch present → allow.
  // Row 5: no PR + branch missing → allow (first-push case, Q2 clarification —
  //        `createFeature`'s local-only branch has not yet been pushed to origin).
  // Row 6: no PR + branch present → allow (branch pre-existed but has no PR).
  return { kind: 'allow' };
}
