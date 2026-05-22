# Feature Specification: on-sibling-review gate and review-phase sibling coordination

**Branch**: `692-phase-3-multi-repo` | **Date**: 2026-05-22 | **Status**: Draft

## Summary

Phase 3 of [multi-repo workflow support](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-repo-workflows-plan.md). Coordinates the review phase across the primary PR and its linked siblings.

After Phase 2 (#691), a workflow can produce a primary PR plus N linked sibling PRs via the `siblingFanoutHandler`. Today the review phase only knows about the primary -- sibling PRs sit as drafts until someone manually flips them to ready-for-review, and the review gate doesn't wait for sibling approvals before considering the workflow merge-ready.

This issue adds two capabilities:
1. **Ready-for-review sync** -- mirrors the primary PR's ready-for-review state to all linked sibling PRs when the review phase begins.
2. **`on-sibling-review` gate condition** -- pauses the workflow until all linked PRs are approved, using the same label-driven mechanism as the existing `on-questions` clarification gate.

## User Stories

### US1: Reviewer sees all related PRs ready for review simultaneously

**As a** code reviewer on a multi-repo project,
**I want** all sibling PRs to be marked ready-for-review when the primary PR enters review,
**So that** I can review the full changeset across repos without waiting for manual draft-to-ready flips.

**Acceptance Criteria**:
- [ ] When `prManager.markReadyForReview()` runs on the primary PR, all `WorkflowState.linkedPRs` are flipped to ready-for-review via `gh pr ready`
- [ ] If a sibling PR was already manually marked ready, the operation is a no-op (no error)
- [ ] If a sibling PR flip fails (e.g., repo deleted, permissions), the error is logged but does not block the primary

### US2: Workflow pauses until all sibling PRs are approved

**As a** workflow operator,
**I want** the workflow to wait for approval on all linked PRs before proceeding past the review gate,
**So that** the entire multi-repo changeset is reviewed before the workflow considers itself merge-ready.

**Acceptance Criteria**:
- [ ] A new `on-sibling-review` gate condition is available in `GateDefinition.condition`
- [ ] When active, the gate checks every PR in `linkedPRs` for the approval label
- [ ] Gate is satisfied only when all linked PRs have the approval label
- [ ] With no linked PRs, the gate is immediately satisfied (no-op)
- [ ] Waiting state surfaces via `waiting-for:sibling-review` / `completed:sibling-review` labels (same pattern as clarification gate)

## Scope

### Ready-for-review sync

- Hook into the existing `prManager.markReadyForReview()` call path (called from `claude-cli-worker.ts` at workflow completion).
- Iterate `WorkflowState.linkedPRs` (type: `LinkedPR[]` from `packages/workflow-engine/src/types/store.ts`), calling `gh pr ready <url>` for each.
- Best-effort: log errors per sibling, continue with remaining siblings.

### New gate condition: `on-sibling-review`

- **Type extension**: Add `'on-sibling-review'` to the `condition` enum in `GateDefinitionSchema` (`packages/orchestrator/src/worker/config.ts`, line ~11) and `GateDefinition` interface (`packages/orchestrator/src/worker/types.ts`, line ~106).
- **Gate checker**: Extend `gate-checker.ts` to handle `on-sibling-review`. Needs access to `WorkflowState.linkedPRs` and a GitHub client to check labels on sibling PRs.
- **Condition evaluation in phase-loop**: In `phase-loop.ts` (lines ~403-494), add an `else if (gate.condition === 'on-sibling-review')` branch alongside the existing `on-questions` branch. Check if all sibling PRs have the approval label; if any lack it, `gateActive = true`.
- **Label convention**: Uses `waiting-for:sibling-review` as the gate label. `completed:sibling-review` marks satisfaction. Follows the existing `waiting-for:X` / `completed:X` pattern from `label-manager.ts`.
- **Default gate config**: Add to `speckit-feature` workflow gates in `config.ts` (line ~36): `{ phase: 'implement', gateLabel: 'waiting-for:sibling-review', condition: 'on-sibling-review' }`. The gate fires after the implement phase (same phase as `waiting-for:implementation-review`), creating a two-step review: primary approval + sibling approval.

### Key files to modify

| File | Change |
|------|--------|
| `packages/orchestrator/src/worker/types.ts` | Add `'on-sibling-review'` to `GateDefinition.condition` |
| `packages/orchestrator/src/worker/config.ts` | Add to `GateDefinitionSchema` condition enum; add to default gate configs |
| `packages/orchestrator/src/worker/gate-checker.ts` | Handle `on-sibling-review` condition |
| `packages/orchestrator/src/worker/phase-loop.ts` | Add `on-sibling-review` evaluation branch in gate logic |
| `packages/orchestrator/src/worker/pr-manager.ts` | Extend `markReadyForReview()` to iterate `linkedPRs` |
| `packages/workflow-engine/src/types/store.ts` | No changes needed -- `LinkedPR` and `linkedPRs` already exist |

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extend `GateDefinition.condition` with `'on-sibling-review'` | P1 | Zod schema + TypeScript type |
| FR-002 | Implement sibling label check in gate-checker | P1 | Query labels on each `linkedPRs[].url` via GitHub API |
| FR-003 | Add `on-sibling-review` evaluation branch in phase-loop gate logic | P1 | Follows `on-questions` pattern |
| FR-004 | Mirror ready-for-review to sibling PRs in `markReadyForReview()` | P1 | `gh pr ready <url>`, best-effort |
| FR-005 | Add default gate config entry for `on-sibling-review` | P2 | In `speckit-feature` workflow |
| FR-006 | No-op when `linkedPRs` is empty or undefined | P1 | Gate immediately satisfied |
| FR-007 | Token propagation for cross-repo GitHub API calls | P1 | Reuse `tokenProvider` pattern from #620 |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Sibling PRs flipped to ready-for-review | All linked PRs | Verify via `gh pr view` after review phase starts |
| SC-002 | Gate pauses when sibling lacks approval | Workflow blocked with `waiting-for:sibling-review` label | Check label on primary issue |
| SC-003 | Gate resumes when all siblings approved | Workflow unblocked, `completed:sibling-review` label applied | Label state after all approvals |
| SC-004 | Empty linkedPRs = no-op | Gate satisfied immediately, no labels added | Workflow proceeds without pause |

## Assumptions

- Phase 2 (#691) is merged and `WorkflowState.linkedPRs` is populated by the sibling fan-out handler.
- The approval label name on sibling repos matches the primary repo convention (same label-manager label set).
- The GitHub token available to the orchestrator has permissions to mark PRs ready and read labels on sibling repos (same org).
- Sibling PRs are in the same GitHub organization as the primary.

## Out of Scope

- Coordinated **merge** across PRs. Reviewers approve; humans merge. Auto-merge in dependency order is a separate, larger feature.
- Cross-repo CI status aggregation ("don't approve until all sibling CIs are green"). Reviewers see CI status on each PR individually.
- Re-syncing PR titles/descriptions when the primary changes.
- Webhook-driven gate satisfaction (polling/label-checking only; no real-time webhook listener for sibling approval events).

## Dependencies

- **Hard**: Issue C (`LinkedPR` schema in `WorkflowState`) -- already merged.
- **Hard**: Issue E (#691, sibling fan-out handler that populates `linkedPRs`) -- Phase 2.

## Blocks

Nothing. This is the last issue in the planned multi-repo scope. Follow-on work (coordinated merge ordering, cross-repo CI aggregation) is deferred.

---

*Generated by speckit*
