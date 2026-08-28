# Feature Specification: Plan-phase commit must not carry repo-root agent-context files; fix the dead #899 drift guard

**Branch**: `1218-problem-two-gaps-let` | **Date**: 2026-08-28 | **Status**: Draft

## Summary

Two gaps let transient per-feature notes land in repo-root `CLAUDE.md` via cluster workers,
despite #899. First, `pr-manager.ts` stages and commits agent-context files (`CLAUDE.md`,
`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`) like any product file during the
plan phase. Second, the #899 Layer-1 drift guard static-greps a code path
(`operations/plan.ts` `buildPlanPrompt()`) that cluster workers never execute — they run the
bare `/plan` slash command installed from agency — so the guard has stayed green while the
regression it targets stayed live.

The prompt instruction that causes the bloat is being removed in a sibling agency issue. This
issue is the **engine-side belt-and-suspenders**: even if a prompt regression re-introduces the
"Update agent context files" instruction, the plan-phase commit must not carry those files, and
the drift guard must watch something real.

## Problem

**1. `pr-manager.ts` commits agent-context files unconditionally.**
`packages/orchestrator/src/worker/pr-manager.ts:150-162` stages everything except engine
sidecars (`isEngineSidecar` / `isCollapsedEngineStateDir`). `CLAUDE.md` is staged and committed
like any product file. Since #1107, `EXCLUDED_EXACT_PATHS` in
`packages/orchestrator/src/worker/product-diff.ts:95-100` already enumerates the four
agent-context files — but only so a CLAUDE.md-only implement phase fails the empty-diff guard;
it does nothing to keep the file out of the commit. No phase (review, validate, PR-prep,
ready-for-review) ever reverts or flags CLAUDE.md deltas.

**2. The #899 Layer-1 drift guard watches a path the worker never runs.**
`packages/workflow-engine/src/actions/builtin/speckit/__tests__/managed-file-disjointness.test.ts:86-96`
static-greps `operations/plan.ts`'s `buildPlanPrompt()`. Cluster workers don't use that
wrapper; they run the bare `/plan` slash command installed from agency (`PHASE_TO_COMMAND`,
`packages/generacy-plugin-claude-code/src/launch/constants.ts`), whose markdown still says
"Update agent context files … Updates CLAUDE.md". The guard has been green while the regression
it targets stayed live.

## User Stories

### US1: Plan-phase commits stay free of agent-context bloat

**As a** maintainer of the cluster runtime,
**I want** the plan-phase completion commit to exclude and revert repo-root agent-context files,
**So that** a prompt regression can never re-bloat `CLAUDE.md` (or the other agent-context
files) through a worker-produced plan commit.

**Acceptance Criteria**:
- [ ] A plan-phase commit with a dirty `CLAUDE.md` and a dirty `specs/x/stack.md` commits only
  `stack.md`.
- [ ] The working tree is clean after the plan-phase commit (reverted tracked files restored;
  untracked agent-context files deleted).
- [ ] A warning is logged naming the reverted paths.
- [ ] An implement-phase commit with a dirty `CLAUDE.md` is unchanged (CLAUDE.md still
  committed) — the revert is scoped to `plan` only.

### US2: The drift guard watches a path the worker actually executes

**As a** maintainer relying on the #899 disjointness invariant,
**I want** the Layer-1 guard to stop asserting on dead code and to document where each layer of
the invariant now lives,
**So that** a green guard reflects a real, enforced protection rather than a false sense of
safety.

**Acceptance Criteria**:
- [ ] `managed-file-disjointness.test.ts` no longer asserts on `operations/plan.ts` /
  `buildPlanPrompt`.
- [ ] The test file header comment and
  `specs/899-found-during-cockpit-v1/contracts/merge-tree-invariant.md` state that the
  prompt-side invariant is pinned in agency (`agency-plugin-spec-kit` tests) and the
  engine-side invariant is the pr-manager revert.
- [ ] Layer 2 (merge-tree simulation) is retained.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | At the plan-phase completion commit, exclude paths matching `EXCLUDED_EXACT_PATHS` from `toStage`. | P1 | Reuse `EXCLUDED_EXACT_PATHS`; do not duplicate the list. |
| FR-002 | Revert the excluded paths in the working tree — `git checkout -- <path>` for tracked files, delete for untracked files — so they don't leak into a later phase's commit or trip dirty-tree checks. | P1 | |
| FR-003 | Log a warning naming the reverted paths. | P2 | |
| FR-004 | Scope the exclude-and-revert behavior to the `plan` phase only. | P1 | Implement-phase CLAUDE.md edits can be legitimate durable guidance. |
| FR-005 | Remove the dead `buildPlanPrompt` grep from `managed-file-disjointness.test.ts` (or repoint it at a path the worker actually executes). | P1 | |
| FR-006 | Update the test file header comment and `specs/899-found-during-cockpit-v1/contracts/merge-tree-invariant.md` to document where the prompt-side and engine-side invariants now live. | P2 | |
| FR-007 | Retain Layer 2 (merge-tree simulation) of the #899 guard. | P1 | |
| FR-008 | Update the `CLAUDE.md` pointer paragraph (`CLAUDE.md:5-11`) and `docs/` if they describe the #899 guard. | P3 | |
| FR-009 | Add a changeset for `@generacy-ai/orchestrator` (and `workflow-engine` if touched). | P1 | CI gate. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | New pr-manager unit tests | Pass | Plan-phase revert behavior covered by tests |
| SC-002 | Existing #1162 sidecar tests | Unchanged & passing | Test suite run |
| SC-003 | `managed-file-disjointness.test.ts` assertions on `operations/plan.ts` | Zero | Grep the test file |
| SC-004 | Repo-root agent-context files in a plan-phase commit | Zero | Test asserting commit contents |

## Assumptions

- The sibling agency issue removes the "Update agent context files" instruction from the `/plan`
  slash command markdown; this issue does not depend on that landing first (it is the
  belt-and-suspenders layer).
- `EXCLUDED_EXACT_PATHS` remains the single source of truth for the four agent-context file
  paths.

## Out of Scope

- Removing the prompt-side instruction from the agency `/plan` command (handled in the sibling
  agency issue).
- Reverting or flagging agent-context deltas in non-plan phases (review, validate, PR-prep,
  ready-for-review, implement) — implement-phase edits are intentionally preserved.

---

*Generated by speckit*
