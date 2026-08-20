# Feature Specification: Merge-conflict re-arm targets a resolution-scoped review, not the interrupted phase

**Branch**: `1131-context-worker-merge-conflict` | **Date**: 2026-08-20 | **Status**: Draft

## Summary

Today, after `MergeConflictHandler` resolves a merge conflict, it re-arms the **interrupted phase** (typically `validate`) via `HandlerOutcome { outcome: 're-armed', startPhase: metadata.phase }` (`merge-conflict-handler.ts:659`). That forces a full validate suite re-run on every resolution and — more importantly — treats the resolution as if the merge introduced no new risk.

This issue changes the success re-arm target: after a successful resolution, re-arm into a **`review` phase scoped to the resolution diff** (the merge commit vs. the pre-merge branch tip), not the interrupted phase. A clean scoped review proceeds toward `validate` through the normal phase flow; a scoped review that surfaces findings enters the `remediate` loop. The scoped review reads the resolution base/head SHAs from the pause-context sidecar. The failure path (`blocked:stuck-merge-conflicts`) is unchanged.

This closes a **semantic-conflict safety gap**: a merge resolution can silently change program behavior even when git reports a clean tree (the handler's success predicate is git-state only — no build/test — at `merge-conflict-handler.ts:104`, `:479`). Routing through a resolution-scoped review lets the engine inspect the merge diff, and the invariant guarantees that no resolution reaches merge readiness without `validate` running on the post-merge state.

## Context

- `MergeConflictHandler` (`packages/orchestrator/src/worker/merge-conflict-handler.ts`) resolves conflicts with a **single** agent-CLI attempt and a **git-state-only** success predicate (no `MERGE_HEAD`, no unmerged paths, no conflict markers — `:479`). It never spawns a build or test during resolution.
- On success it calls `finishSuccess` (`:631`), which returns `{ outcome: 're-armed', startPhase: metadata.phase }` — re-arming the interrupted phase carried in the pause-context sidecar (`ResolveMergeConflictsMetadata.phase`, `monitor.ts:84`).
- The `review` and `remediate` phases are the engine-native review machinery introduced by epic generacy-ai/generacy#1120 (P1 phase plumbing #1121; review executor + findings artifact #1124; PR posting + draft/ready lifecycle #1125; re-review convergence #1126). `review` is an agent phase over a diff; `remediate` is the off-sequence fix loop it feeds.
- The pause-context sidecar (`ResolveMergeConflictsMetadata`) currently carries `phase`, `conflictedPathsAtPause?`, and `prNumber?`. It does **not** yet carry the resolution base/head SHAs the scoped review needs to bound its diff window.
- Failure disposition (`blocked:stuck-merge-conflicts`, `waiting-for:merge-conflicts` preserved, evidence emitted) is out of scope for change.

Part of epic generacy-ai/generacy#1120 (engine-native review & remediate phases). Full design: `docs/engine-review-remediate-plan.md` in generacy-ai/tetrad-development; a condensed design summary lives in the epic body.

## User Stories

### US1: A resolved merge conflict is reviewed for semantic risk before it can merge

**As a** maintainer relying on the autonomous conflict resolver,
**I want** a successful resolution to route into a review scoped to just the resolution diff,
**So that** a git-clean-but-semantically-broken merge is caught by the review/remediate loop instead of silently advancing toward merge.

**Acceptance Criteria**:
- [ ] After a successful resolution, the handler re-arms into `review` (not the interrupted phase).
- [ ] The scoped review's input diff is the merge commit vs. the pre-merge branch tip — unrelated files in the branch are excluded.
- [ ] A clean scoped review proceeds toward `validate` through the normal phase flow.
- [ ] A scoped review with findings enters the `remediate` loop (not merge).

### US2: No resolution reaches merge readiness without validate running on the post-merge state

**As a** maintainer,
**I want** a hard invariant that `validate` runs against the post-merge tree before merge readiness,
**So that** semantic conflicts the scoped review missed are still caught by the full suite on the merged state.

**Acceptance Criteria**:
- [ ] There is no success path from resolution → merge readiness that bypasses `validate` on the post-merge state.
- [ ] The clean-scoped-review path lands in `validate` per the normal flow (does not skip straight to ready/merge).

### US3: The scoped review reads what it needs from the pause-context sidecar

**As a** developer of the resolution flow,
**I want** the resolution base/head SHAs carried in the pause-context sidecar,
**So that** the scoped review can deterministically bound its diff window without re-deriving state from labels or the live branch.

**Acceptance Criteria**:
- [ ] The sidecar carries the resolution base SHA (pre-merge branch tip) and head SHA (merge commit).
- [ ] The scoped review derives its diff window from those SHAs, not from labels or ambient git state.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On successful resolution, `MergeConflictHandler` re-arms into a `review` phase scoped to the resolution diff, not the interrupted phase carried in `metadata.phase`. | P1 | Replaces the `startPhase: metadata.phase` re-arm at `merge-conflict-handler.ts:659`. |
| FR-002 | The scoped review's diff window is the merge commit vs. the pre-merge branch tip; unrelated branch files are excluded from its input. | P1 | Resolution-scoped, not whole-branch. |
| FR-003 | A clean scoped review proceeds toward `validate` through the normal phase flow. | P1 | Normal forward flow, not a shortcut to ready/merge. |
| FR-004 | A scoped review that surfaces findings enters the `remediate` loop. | P1 | Reuses the epic's review→remediate machinery. |
| FR-005 | No success path reaches merge readiness without `validate` having run on the post-merge state. | P1 | Semantic-conflict safety invariant. |
| FR-006 | The pause-context sidecar (`ResolveMergeConflictsMetadata`) carries the resolution base SHA and head SHA the scoped review consumes. | P1 | Extends the sidecar shape at `monitor.ts:67`. |
| FR-007 | Resolution itself spawns no build or test process. | P1 | Preserves the current git-state-only success predicate. |
| FR-008 | The failure disposition (`blocked:stuck-merge-conflicts`, preserved `waiting-for:merge-conflicts`, evidence emission) is unchanged. | P1 | No change to the blocked path. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | A harness drives conflict → resolve → scoped review → validate. | Full traversal | Integration test asserting the phase sequence. |
| SC-002 | The scoped review's input excludes files unrelated to the resolution diff. | Excluded | Assertion on the review's diff window against a fixture with unrelated branch files. |
| SC-003 | No build or test process is spawned during resolution itself. | 0 spawned | Assertion on process spawns across the resolution attempt. |
| SC-004 | No success path reaches merge readiness without `validate` on the post-merge state. | 0 bypass paths | Phase-sequence assertion; the clean-review branch lands in `validate`. |
| SC-005 | The blocked path (`blocked:stuck-merge-conflicts`) behaves identically to today. | Byte-identical disposition | Regression assertion on the blocked branch. |

## Assumptions

- The `review` and `remediate` phases and their re-arm/entry seams from epic #1120 (P1–P2: #1121/#1124/#1125/#1126) are available for the handler to target. If they have not landed on the base branch, the implement phase dependency-blocks until they merge.
- "Scoped review" reuses the epic's review executor with a diff window bounded to the resolution base/head SHAs — it does not introduce a new review mechanism.
- The resolution base SHA (pre-merge branch tip) and head SHA (merge commit) are both known at handler success time (the handler creates the merge commit), so populating the sidecar is a local operation.
- `validate` continues to run against the post-merge tree in the normal forward flow; this issue does not alter validate's own behavior.

## Out of Scope

- The failure path (`blocked:stuck-merge-conflicts`) and its evidence block — unchanged (FR-008).
- The review executor, findings-artifact shape, PR posting/draft-ready lifecycle, and remediate loop internals — owned by the epic's other issues (#1124/#1125/#1126/#1128); this issue only re-arms into them.
- The single-attempt agent-CLI resolution discipline and its retry budgets — unchanged.
- Merge readiness / final-approval gating semantics beyond the "validate must run" invariant.

---

*Generated by speckit*
