# Implementation Plan: Deterministic branch/spec-slug + PR dedup on speckit workflow re-entry

**Feature**: Make branch, spec-slug, and PR derivation for an issue idempotent across `speckit-feature` / `speckit-bugfix` re-entries so a second `implement` visit cannot cut a fresh branch or open a duplicate PR.
**Branch**: `1043-summary-when-speckit-feature`
**Status**: Complete
**Spec**: [`spec.md`](./spec.md) · **Clarifications**: [`clarifications.md`](./clarifications.md)
**Issue**: [generacy-ai/generacy#1043](https://github.com/generacy-ai/generacy/issues/1043)

## Summary

The bug (`spec.md` §Observed Incident): `speckit-feature` re-entered `implement` on `generacy-ai/generacy#1038` after a `cockpit_advance(implementation-review)`. `createFeature()` in `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` re-derived the branch name from `input.description` — a different slug than first entry (`1038-part-cockpit-remote-gates` vs. the original `1038-issue-1038`) — never matched the existing `specs/1038-issue-1038/` idempotency check at `feature.ts:320`, and fell through to the fresh-branch path at `feature.ts:384`. `PrManager.ensureDraftPr()` at `packages/orchestrator/src/worker/pr-manager.ts:139` then called `findPRForBranch(newBranch)` — which only queries the current branch, not the `<N>-*` family — got nothing, and opened PR #1041 alongside the real PR #1039.

The fix ships **US1 + US2 only** (clarifications Q3 → A). US3's review-gate re-cycle is deferred to a follow-up gated on [#849](https://github.com/generacy-ai/generacy/pull/849). FR-006 stays in `spec.md` as intent; no acceptance test lands here.

**Load-bearing architectural choices** (from clarifications):

- **Q1 → A** — the source of truth for `issue N → <N>-<slug>` is **remote git branches only**. No Redis key (avoids the stale-key/TTL class that produced [#849](https://github.com/generacy-ai/generacy/pull/849)); no local index; no issue-body marker. Every entry re-queries the remote — cheap because it collapses to one `git ls-remote origin '<N>-*'` + one `gh pr list --state open`.
- **Q2 → A** — tiebreak when the remote contains multiple `<N>-*` branches AND multiple open PRs: **oldest open PR wins, its head branch is canonical**. Any other `<N>-*` branch without an associated open PR is ignored (not deleted). Encodes the one-open-PR-per-issue invariant and — as verified against the #1038 incident — keeps real PR #1039, ignores spec-only PR #1041.
- **Q4 → A** — **do not modify slug-generation logic**. Under Q1-A, the first-created remote branch IS the persisted first-derived slug; FR-002's "reuse oldest branch" enforces "first-derived wins forever" with zero re-derivation.
- **Q5 → A** — dedup applies **unconditionally to all workflows** (this PR's own `workflow:speckit-bugfix` run would otherwise be unprotected). The `speckit-feature` phrasing in `spec.md` §Out of Scope bounds *test coverage*, not implementation scope.

**Fix shape** — a single resolver `resolveIssueBranch(issueNumber, ghClient, owner, repo, git)` in `packages/workflow-engine/src/actions/builtin/speckit/lib/issue-branch-resolver.ts` returns `{ branchName: string, source: 'oldest-open-pr' | 'oldest-remote-branch' } | null`. Two callers:

1. **`createFeature()`** (`feature.ts:273`) — a new optional `resolveExistingBranch?: (issueNumber: number) => Promise<string | null>` callback on `CreateFeatureInput`. When it returns a name, `createFeature` uses that as `branchName` and skips `buildBranchNameFromPattern()` entirely. Existing idempotency check at `feature.ts:320` continues to gate re-scaffold. Keeps `feature.ts` git-only (Q1-A satisfied for the fallback path); GitHubClient injection stays at the action-wrapper layer.
2. **`PrManager.ensureDraftPr()`** (`pr-manager.ts:139`) — before `findPRForBranch(currentBranch)`, call `resolveIssueBranch(issueNumber, …)`. If it returns a branch different from `getCurrentBranch()`, log `event: 'workflow-reentry-branch-mismatch'` (FR-005), do NOT open a new PR — either reuse the existing PR via `findPRForBranch(canonicalBranch)` or refuse and leave the workflow paused. Under the invariant that `createFeature` already picked the canonical branch, this is defense-in-depth: it prevents pr-manager from being the *sole* dedup site (a Q4-A-compliant Belt-and-Suspenders pattern that keeps the fix working even if `createFeature`'s callback is not wired).

**Design invariants** (upheld across US1/US2):

1. **Zero mutation of existing branches or PRs.** Extra `<N>-*` branches without PRs are ignored, not deleted (Q2-A). No cleanup of pre-existing duplicate `specs/<N>-*` directories (spec Out of Scope).
2. **Structured observability everywhere.** `event: 'workflow-reentry-branch-reused'` on the happy path (SC-003), `event: 'workflow-reentry-branch-mismatch'` on the defensive path (FR-005). Both include `{ issueNumber, existing, wouldCreate, source }`.
3. **Slug derivation logic is unchanged** (Q4-A). Zero LOC touched in `generateConfigurableSlug()` or `buildBranchNameFromPattern()`. Their behavior remains the fallback when `resolveExistingBranch()` returns `null`.
4. **Callback pattern preserves `speckit/lib/feature.ts` git-only surface.** The library is imported by both `packages/workflow-engine` executors and — via `create-feature.ts` action — by ad-hoc CLI paths. Injecting a `GitHubClient` directly into the library would force every caller to wire one; the callback shape defaults to `undefined` and preserves existing behavior for non-orchestrator callers.
5. **PR tiebreak is PR-first, branch-second** (Q2-A). The resolver's ordering: (a) enumerate open `<N>-*` PRs, sort by `created_at`, oldest wins; (b) only if zero open PRs, enumerate remote `<N>-*` branches, sort by commit date, oldest wins; (c) only if zero branches, return `null` → caller falls back to `buildBranchNameFromPattern()`.

## Technical Context

**Language/Version**: TypeScript, Node.js ≥22 (matches `packages/orchestrator/package.json`, `packages/workflow-engine/package.json`).

**Primary Dependencies**:
- `simple-git` — already used by `feature.ts` for local branch/checkout ops; used by the resolver's branch-listing fallback path.
- `@generacy-ai/workflow-engine` `GitHubClient` (`packages/workflow-engine/src/actions/github/client/gh-cli.ts`) — the resolver calls `listOpenPullRequests()` (line 756) and `listBranches()` (line 1308). Both already exist and have the exact `gh api` / `gh pr list` shapes the fix needs.
- `vitest` — test runner; existing suites under `packages/workflow-engine/tests/actions/speckit/deterministic.test.ts` extended for the resolver.

**Storage**: None new. All state lives in remote git + GitHub PRs (Q1-A).

**Testing**: `vitest`. New resolver unit tests + extensions to `deterministic.test.ts` for `createFeature`'s callback path + a new PR-dedup unit test under `packages/orchestrator/src/__tests__/pr-manager-issue-dedup.test.ts`.

**Target Platform**: CI runners (Linux, Node ≥22).

**Project Type**: Multi-package library fix. Touched packages:
- `packages/workflow-engine/src/actions/builtin/speckit/lib/` — new `issue-branch-resolver.ts`; extended `feature.ts` (~30 LOC added, zero deleted from slug-gen logic).
- `packages/workflow-engine/src/actions/builtin/speckit/types.ts` — new optional `resolveExistingBranch` on `CreateFeatureInput`.
- `packages/workflow-engine/src/actions/builtin/speckit/operations/create-feature.ts` OR the calling `SpeckitCreateFeatureAction` in `actions/builtin/speckit/` — wires the resolver callback from `ActionContext.github`.
- `packages/orchestrator/src/worker/pr-manager.ts` — extended `ensureDraftPr()` to call the resolver.

**Performance Goals**: Resolver adds one `gh pr list --state open --json headRefName,createdAt --limit 100` (~200–400 ms) + one `git ls-remote origin '<N>-*'` (~100–300 ms) per phase entry. Total added latency per re-entry: <1 s. Not on any hot path (phase-entry frequency is minutes, not seconds).

**Constraints**:
- No network beyond the existing `gh` CLI calls (already required by orchestrator).
- No changes to slug-generation algorithm (Q4-A).
- No changes to `cockpit_status`, `cockpit_merge`, or PR-picker logic (`spec.md` Out of Scope).
- Test coverage scoped to `workflow:speckit-feature` scenarios per `spec.md` §Out of Scope; implementation applies to all workflows (Q5-A).

**Scale/Scope**: ~250 LOC added across 4–5 files. Total additions: 1 new source file, 1 new test file, 2 modified source files (`feature.ts`, `pr-manager.ts`), 1 modified test file (`deterministic.test.ts`), 1 modified types file, 1 changeset. **No user-facing surface** — the fix is purely internal to the orchestrator's phase-loop.

## Project Structure

```
packages/
  workflow-engine/
    src/actions/builtin/speckit/
      lib/
        feature.ts                       # MODIFIED: accept resolveExistingBranch callback in createFeature
        issue-branch-resolver.ts         # NEW: resolveIssueBranch() — pure function, injectable ghClient
        fs.ts                            # unchanged
      operations/
        create-feature.ts                # MODIFIED (or wrapper action): construct resolver, pass callback
      types.ts                           # MODIFIED: add resolveExistingBranch? to CreateFeatureInput
    tests/actions/speckit/
      deterministic.test.ts              # MODIFIED: add resume-with-different-description scenario
      issue-branch-resolver.test.ts      # NEW: unit tests for resolver's 5 decision branches
  orchestrator/
    src/worker/
      pr-manager.ts                      # MODIFIED: dedup guard in ensureDraftPr() calls resolver
    src/__tests__/
      pr-manager-issue-dedup.test.ts     # NEW: regression test — 2 branches + 2 open PRs → oldest wins

specs/1043-summary-when-speckit-feature/
  plan.md                                # this file
  research.md                            # NEW (this phase)
  data-model.md                          # NEW (this phase)
  contracts/
    issue-branch-resolver.md             # NEW (this phase): resolver contract shape
  quickstart.md                          # NEW (this phase): reproduce + verify

.changeset/
  1043-deterministic-branch-pr-dedup.md  # NEW: minor for @generacy-ai/workflow-engine + @generacy-ai/orchestrator
```

## Constitution Check

*No `.specify/memory/constitution.md` exists (verified — `.specify/` only holds `templates/`). Standard project conventions apply:*

- ✅ **Changesets (CLAUDE.md gate)**: Non-test edits under `packages/workflow-engine/src/` and `packages/orchestrator/src/` trigger the gate. One changeset: `.changeset/1043-deterministic-branch-pr-dedup.md`. Bump level:
  - `@generacy-ai/workflow-engine` — **minor**. The new `resolveExistingBranch?: (issueNumber) => Promise<string | null>` field on `CreateFeatureInput` is a **new public capability** (per CLAUDE.md "new capability → minor"). Optional, backwards-compatible for existing callers.
  - `@generacy-ai/orchestrator` — **patch**. Internal fix to `PrManager.ensureDraftPr()`; no new exports.
- ✅ **Every touched non-test package listed**: workflow-engine, orchestrator. Single changeset lists both.
- ✅ **No new dependencies**: `simple-git`, `zod`, `@generacy-ai/workflow-engine` GitHubClient all already present.
- ✅ **Never-merge-on-red**: unaffected (this IS a bugfix landing under `workflow:speckit-bugfix`).
- ✅ **Observer independence** (upheld from #1015): the resolver does not touch cockpit claim state.
- ✅ **Deferred slug-generation changes** (Q4-A): zero LOC touched in `generateConfigurableSlug()` / `buildBranchNameFromPattern()`.

## Deferred Clarifications — Plan-Phase Decisions

Five clarifications resolved in `clarifications.md` (Q1–Q5). Four implementer-selectable decisions recorded here:

### D-1: Resolver injection shape — callback vs. direct dependency

**Choice**: **Callback** — `CreateFeatureInput.resolveExistingBranch?: (issueNumber: number) => Promise<string | null>`.

**Rationale**:
- `feature.ts` is imported by both workflow-engine executors AND ad-hoc CLI paths (`operations/create-feature.ts` wraps it for the `create_feature` MCP tool from the ported speckit server — see `feature.ts` docstring). Direct `GitHubClient` injection would force every caller to construct one.
- Callback shape defaults to `undefined`; existing behavior for non-orchestrator callers is preserved.
- Tests mock the callback trivially (no HTTP interception, no `gh` CLI stubbing at the library layer — `deterministic.test.ts` already mocks git; the callback shape composes with that).

**Rejected alternative**: Refactor `createFeature` to accept a `GitHubClient` directly. Larger surface change; forces the MCP-tool wrapper to construct a stub client for non-orchestrator paths.

### D-2: Resolver location — new module in workflow-engine vs. new module in orchestrator

**Choice**: `packages/workflow-engine/src/actions/builtin/speckit/lib/issue-branch-resolver.ts`.

**Rationale**:
- Co-located with `feature.ts` — the primary caller. Symmetric with existing lib pattern (`fs.ts`, `feature.ts` in same directory).
- `PrManager` already depends on `@generacy-ai/workflow-engine` (`GitHubClient` type at `pr-manager.ts:1`), so cross-package import is free.
- Keeps orchestrator's `worker/` directory focused on phase-loop machinery, not workflow-specific business rules.

**Rejected alternative**: `packages/orchestrator/src/worker/issue-branch-resolver.ts`. Would invert the dependency arrow (workflow-engine would need to import from orchestrator to give `createFeature` access to the resolver).

### D-3: Defensive path in `pr-manager` — refuse vs. auto-adopt

**Choice**: **Auto-adopt** — when `resolveIssueBranch()` returns a canonical branch different from `getCurrentBranch()`, call `findPRForBranch(canonicalBranch)`, adopt that PR, log `event: 'workflow-reentry-branch-mismatch'` (FR-005), do NOT open a new PR.

**Rationale**:
- Under the invariant that `createFeature`'s callback is wired, this branch is unreachable in normal operation. Auto-adopt is a safety net.
- Refusing (throwing) would break workflows that upgrade in-place before both callers are wired. Auto-adopt fails-forward safely.
- The structured log makes any occurrence observable; SC-005 (zero manual PR closures per week) becomes a real regression detector.

**Rejected alternative**: Throw and mark the phase failed with `agent:error`. Correct in principle but too aggressive during the release window — a wired-createFeature + un-wired pr-manager (or vice-versa) is a valid transient state.

### D-4: How the resolver ranks branches when there are zero open PRs

**Choice**: **Commit date** (`git log -1 --format=%ct <remote-ref>`), oldest wins.

**Rationale**:
- Q2-A's tiebreak is PR-first. When no PR exists, the spec says "oldest match" (FR-002); commit date is the operational proxy for "which branch was created first" that survives without extra state.
- Handles the edge case where two `<N>-*` branches exist but neither has an open PR (e.g., both PRs got closed manually). Deterministic tiebreak keeps the resolver a pure function of remote state.

**Rejected alternative**: Use `refname` alphabetical sort. Would sort `1038-issue-1038` after `1038-a-…` deterministically but based on slug alphabet — brittle if slug conventions change.

## Success Metrics — How the Plan Maps to `spec.md` §Success Criteria

| SC | Metric | How the plan satisfies it |
|----|--------|---------------------------|
| SC-001 | 0 duplicate spec-only PRs / issue / 30 days | Resolver called before `createFeature` + `ensureDraftPr` makes duplicate opens structurally impossible. Regression test asserts the #1038 scenario. |
| SC-002 | Exactly 1 `specs/<N>-*` dir per issue | `feature.ts:320` idempotency check gates re-scaffold. With canonical branch resolved first, the check now always matches on re-entry. |
| SC-003 | 100% re-entry reuses existing branch | Structured log `event: 'workflow-reentry-branch-reused'` emitted from `createFeature` when the resolver returns a match. Assertion in the new resolver unit test. |
| SC-004 | 0 re-cycled `waiting-for:implementation-review` labels | **Deferred to US3 follow-up** per Q3-A. FR-006 remains as intent. |
| SC-005 | 0 manual PR closures / week | Enforced by the auto-adopt defensive path in `pr-manager.ts` (D-3) + structured log for observability. |

## Testing Strategy

Three layers:

1. **Resolver unit tests** (`issue-branch-resolver.test.ts`) — 5 scenarios covering the decision tree:
   - Zero `<N>-*` branches → returns `null` (fallback path).
   - One `<N>-*` branch, no PR → returns that branch, `source: 'oldest-remote-branch'`.
   - Two `<N>-*` branches, no PRs → returns the older by commit date, `source: 'oldest-remote-branch'`.
   - One `<N>-*` branch with an open PR + one without → returns the PR's branch, `source: 'oldest-open-pr'`.
   - **The #1038 scenario**: two `<N>-*` branches, two open PRs → returns the oldest open PR's branch. Direct regression test against `spec.md` §Observed Incident.

2. **`createFeature` integration** (`deterministic.test.ts` — extend existing suite) — one scenario:
   - Call `createFeature({ number: 1038, description: 'part cockpit remote gates', resolveExistingBranch: () => '1038-issue-1038' })`. Assert: no new branch cut; `specs/1038-issue-1038/` re-used; `git checkout` targeted the callback-returned name; `git_branch_created: false`.

3. **`PrManager` regression** (`pr-manager-issue-dedup.test.ts` — new file) — one scenario:
   - Fake `GitHubClient` reports two open PRs on `<N>-*` branches. Assert: `ensureDraftPr()` adopts the older PR and emits `event: 'workflow-reentry-branch-mismatch'`; `createPullRequest` is never called.

Test-only additions do not trigger the changeset gate (per CLAUDE.md exemption), but non-test source edits do (see Constitution Check).

## Sequencing

- **T-1** (independent) — New `issue-branch-resolver.ts` + `issue-branch-resolver.test.ts`.
- **T-2** (depends on T-1) — Extend `CreateFeatureInput` type + wire callback in `create-feature.ts` action + extend `feature.ts` to prefer callback return over `buildBranchNameFromPattern()` + extend `deterministic.test.ts`.
- **T-3** (depends on T-1) — Modify `pr-manager.ts::ensureDraftPr()` + add `pr-manager-issue-dedup.test.ts`.
- **T-4** — Write `.changeset/1043-deterministic-branch-pr-dedup.md`.

T-2 and T-3 are parallel-safe (touch disjoint files). T-4 waits on both.

## Out of Scope for This PR

*(Restated from `spec.md` §Out of Scope + Q3-A):*

- US3 / FR-006 acceptance test — deferred to a follow-up issue gated on [#849](https://github.com/generacy-ai/generacy/pull/849)'s landing.
- Cleanup of pre-existing duplicate `specs/<N>-*` directories on historical branches.
- Backfill renames on branches created before this fix ships.
- Changes to `cockpit_merge` picker logic (the one-open-PR invariant means the picker doesn't need a tiebreaker).
- Slug-generation algorithm changes (Q4-A: reuse existing derivation).
