# Implementation Plan: Fix pre-existing test failures in claude-cli-worker.test.ts

**Feature**: Phase 0 CI cleanup — fix 15 failing tests caused by mock defaults
**Branch**: `457-credentials-architecture`
**Status**: Complete

## Summary

Fix 15 failing tests in `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts` by aligning the initial mock declaration of `mockGithub.getStatus()` with the `beforeEach` reset. The initial declaration on line 24 defaults `has_changes: false`, which conflicts with the implement phase's `PHASES_REQUIRING_CHANGES` guard in `phase-loop.ts`. The `beforeEach` block (line 193) already corrects this to `true`, but the initial declaration must also be updated to prevent any edge-case failures and maintain consistency.

## Technical Context

**Language/Version**: TypeScript (Node.js)
**Primary Dependencies**: Vitest (test runner), `@generacy-ai/workflow-engine`
**Testing**: `vitest` via `pnpm test` in the orchestrator package
**Target Platform**: Node.js / CI
**Project Type**: Monorepo (`packages/orchestrator`)

## Constitution Check

No `constitution.md` exists in this project. No gates to check.

## Project Structure

### Files to Modify

```text
packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts  # Fix mock default on line 24
```

### Files to Audit (read-only)

```text
packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts  # Check for same issue
packages/orchestrator/src/worker/phase-loop.ts                          # Reference: PHASES_REQUIRING_CHANGES
```

### No Production Code Changes

Per the spec, the `PHASES_REQUIRING_CHANGES` check in `phase-loop.ts` is correct behavior. Only test mock defaults are modified.

## Implementation Steps

### Step 1: Fix initial mock default (line 24)

Change the `getStatus` mock declaration from `has_changes: false` to `has_changes: true`:

```typescript
// Before (line 24):
getStatus: vi.fn().mockResolvedValue({ branch: 'feature/42', has_changes: false, staged: [], unstaged: [], untracked: [] }),

// After:
getStatus: vi.fn().mockResolvedValue({ branch: 'feature/42', has_changes: true, staged: [], unstaged: [], untracked: [] }),
```

This aligns the initial declaration with the `beforeEach` reset on line 193, which already sets `has_changes: true`.

### Step 2: Verify all 61 tests pass

Run `pnpm test` in the orchestrator package and confirm 61/61 pass with 0 skips.

### Step 3: Audit sibling test files

**`pr-feedback-handler.test.ts`**: Uses `has_changes: false` as its `beforeEach` default (line 162). This is **correct** — the PR feedback handler tests don't exercise the implement phase's changes guard, and individual tests that need `has_changes: true` explicitly override (lines 240, 372, 450, etc.). No fix needed.

**Other test files**: `has_changes` appears in only these two test files. No other files are affected.

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Changing default breaks tests that expect `has_changes: false` | Low | The `beforeEach` already overrides to `true`; any test needing `false` already overrides explicitly |
| Other test files affected | None | Grep confirms only 2 files reference `has_changes`; only `claude-cli-worker.test.ts` needs the fix |
