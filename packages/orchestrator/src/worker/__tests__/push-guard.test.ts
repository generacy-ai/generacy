/**
 * Unit tests for `evaluatePushGuard` (#1051 FR-002/003).
 *
 * Covers the 7-case decision matrix from `specs/1051-problem-after-speckit-pr/
 * contracts/push-guard.md § Semantics` plus the two failure-isolation cases.
 *
 * The guard emits NO logs — assertions are shape-only. Caller-side log
 * emissions are covered by `pr-feedback-handler.push-guard.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { evaluatePushGuard } from '../push-guard.js';
import type { PullRequest } from '@generacy-ai/workflow-engine';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: overrides.number ?? 42,
    title: overrides.title ?? 'Test PR',
    body: overrides.body ?? '',
    state: overrides.state ?? 'open',
    draft: overrides.draft ?? false,
    head: overrides.head ?? { ref: 'feature', sha: '', repo: 'o/r' },
    base: overrides.base ?? { ref: 'develop', sha: '', repo: 'o/r' },
    labels: overrides.labels ?? [],
    created_at: overrides.created_at ?? '2026-07-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-07-01T00:00:00Z',
  };
}

function makeInput(opts: {
  pr: PullRequest | null | Error;
  branchExists: boolean | Error;
  owner?: string;
  repo?: string;
  branch?: string;
  issueNumber?: number;
}) {
  const findPr = vi.fn(async () => {
    if (opts.pr instanceof Error) throw opts.pr;
    return opts.pr;
  });
  const remoteBranchExists = vi.fn(async () => {
    if (opts.branchExists instanceof Error) throw opts.branchExists;
    return opts.branchExists;
  });
  return {
    input: {
      owner: opts.owner ?? 'o',
      repo: opts.repo ?? 'r',
      branch: opts.branch ?? 'feature',
      issueNumber: opts.issueNumber ?? 100,
      github: { findPRForBranchAnyState: findPr },
      git: { remoteBranchExists },
    },
    findPr,
    remoteBranchExists,
  };
}

// -------------------------------------------------------------------------
// Decision matrix (7 cases, from contracts/push-guard.md § Semantics)
// -------------------------------------------------------------------------

describe('evaluatePushGuard — decision matrix', () => {
  it('PR merged + branch present → refuse { reason: pr-merged, prNumber }', async () => {
    const { input } = makeInput({
      pr: makePr({ number: 1, state: 'merged' }),
      branchExists: true,
    });
    const decision = await evaluatePushGuard(input);
    expect(decision).toEqual({
      kind: 'refuse',
      reason: 'pr-merged',
      prNumber: 1,
      branch: 'feature',
      owner: 'o',
      repo: 'r',
      issueNumber: 100,
    });
  });

  it('PR closed + branch present → refuse { reason: pr-closed, prNumber }', async () => {
    const { input } = makeInput({
      pr: makePr({ number: 2, state: 'closed' }),
      branchExists: true,
    });
    const decision = await evaluatePushGuard(input);
    expect(decision).toEqual({
      kind: 'refuse',
      reason: 'pr-closed',
      prNumber: 2,
      branch: 'feature',
      owner: 'o',
      repo: 'r',
      issueNumber: 100,
    });
  });

  it('PR merged + branch MISSING → refuse { reason: pr-merged } (row 1 short-circuits over row 3)', async () => {
    const { input } = makeInput({
      pr: makePr({ number: 3, state: 'merged' }),
      branchExists: false,
    });
    const decision = await evaluatePushGuard(input);
    expect(decision.kind).toBe('refuse');
    if (decision.kind === 'refuse') {
      expect(decision.reason).toBe('pr-merged');
      expect(decision.prNumber).toBe(3);
    }
  });

  it('PR open + branch MISSING → refuse { reason: branch-missing, prNumber }', async () => {
    const { input } = makeInput({
      pr: makePr({ number: 4, state: 'open' }),
      branchExists: false,
    });
    const decision = await evaluatePushGuard(input);
    expect(decision).toEqual({
      kind: 'refuse',
      reason: 'branch-missing',
      prNumber: 4,
      branch: 'feature',
      owner: 'o',
      repo: 'r',
      issueNumber: 100,
    });
  });

  it('PR open + branch present → allow', async () => {
    const { input } = makeInput({
      pr: makePr({ number: 5, state: 'open' }),
      branchExists: true,
    });
    const decision = await evaluatePushGuard(input);
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('no PR + branch present → allow', async () => {
    const { input } = makeInput({ pr: null, branchExists: true });
    const decision = await evaluatePushGuard(input);
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('no PR + branch MISSING → allow (first-push case, Q2 clarification — createFeature branch not yet pushed)', async () => {
    // Regression guard for PR #1052 review Finding 1: brand-new issue's local
    // branch has no PR AND is not yet on origin. `createFeature` only runs
    // `git.checkoutLocalBranch`; the first push must be allowed or every new
    // issue dies at the phase-loop-entry guard before any phase executes.
    const { input } = makeInput({ pr: null, branchExists: false });
    const decision = await evaluatePushGuard(input);
    expect(decision).toEqual({ kind: 'allow' });
  });
});

// -------------------------------------------------------------------------
// Failure isolation (per-lookup split — PR #1052 review Finding 4)
// -------------------------------------------------------------------------

describe('evaluatePushGuard — per-lookup failure isolation', () => {
  it('findPRForBranchAnyState throws → refuse { reason: pr-lookup-failed } (Finding 4)', async () => {
    // Regression guard: a rate-limited / auth-expired `gh` call used to
    // collapse silently to `null` (via `if (exitCode !== 0) return null;`)
    // and the guard reclassified as "no PR ever" → allow. Fixed by having
    // `findPRForBranchAnyState` throw on non-zero exit and having the guard
    // refuse rather than fail-open on that specific lookup.
    const { input } = makeInput({
      pr: new Error('gh transient failure'),
      branchExists: true,
    });
    const decision = await evaluatePushGuard(input);
    expect(decision).toEqual({
      kind: 'refuse',
      reason: 'pr-lookup-failed',
      prNumber: null,
      branch: 'feature',
      owner: 'o',
      repo: 'r',
      issueNumber: 100,
    });
  });

  it('remoteBranchExists throws → treated as branch present → decision derives from PR state (allow for open)', async () => {
    // The PR-state lookup is the load-bearing one; branch-existence is
    // secondary. On ls-remote transient, treat branch as present so an
    // open PR does not falsely refuse.
    const { input } = makeInput({
      pr: makePr({ state: 'open' }),
      branchExists: new Error('git ls-remote transient failure'),
    });
    const decision = await evaluatePushGuard(input);
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('both lookups throw → refuse { reason: pr-lookup-failed } (PR lookup dominates)', async () => {
    const { input } = makeInput({
      pr: new Error('gh boom'),
      branchExists: new Error('git boom'),
    });
    const decision = await evaluatePushGuard(input);
    expect(decision.kind).toBe('refuse');
    if (decision.kind === 'refuse') {
      expect(decision.reason).toBe('pr-lookup-failed');
    }
  });
});

// -------------------------------------------------------------------------
// Parallel-lookup shape: both lookups issue independently (not sequential)
// -------------------------------------------------------------------------

describe('evaluatePushGuard — lookups run in parallel', () => {
  it('invokes both findPRForBranchAnyState and remoteBranchExists exactly once', async () => {
    const { input, findPr, remoteBranchExists } = makeInput({
      pr: makePr({ state: 'open' }),
      branchExists: true,
    });
    await evaluatePushGuard(input);
    expect(findPr).toHaveBeenCalledTimes(1);
    expect(remoteBranchExists).toHaveBeenCalledTimes(1);
  });

  it('passes canonical (owner, repo, branch) to findPRForBranchAnyState', async () => {
    const { input, findPr } = makeInput({
      pr: null,
      branchExists: true,
      owner: 'myorg',
      repo: 'myrepo',
      branch: 'mybranch',
    });
    await evaluatePushGuard(input);
    expect(findPr).toHaveBeenCalledWith('myorg', 'myrepo', 'mybranch');
  });

  it('passes branch to remoteBranchExists', async () => {
    const { input, remoteBranchExists } = makeInput({
      pr: null,
      branchExists: true,
      branch: 'mybranch',
    });
    await evaluatePushGuard(input);
    expect(remoteBranchExists).toHaveBeenCalledWith('mybranch');
  });
});
