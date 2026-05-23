# Feature Specification: **Phase 3 of [multi-repo workflow support](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-repo-workflows-plan.md)**

**Branch**: `692-phase-3-multi-repo` | **Date**: 2026-05-23 | **Status**: Draft

## Summary

Once Phase 2 lands, a workflow can produce a primary PR plus N linked sibling PRs. The review phase today only knows about the primary — sibling PRs sit as drafts until someone manually flips them to ready-for-review, and the review gate doesn't wait for sibling approvals before considering the workflow merge-ready.

This issue:
1. Mirrors the primary PR's ready-for-review state to all linked sibling PRs — both when `markReadyForReview()` fires on the primary (idempotent backstop) and when the `on-sibling-review` gate activates (primary path).
2. Adds a new gate condition `on-sibling-review` that pauses the workflow until all linked PRs have GitHub review approval (`reviewDecision === 'APPROVED'`).
3. Adds multi-gate-per-phase support in `gate-checker.ts` so `on-sibling-review` and `waiting-for:implementation-review` coexist as independent gates on the `implement` phase.

## Scope

### Ready-for-review sync

- Extend `prManager.markReadyForReview()` to iterate `WorkflowState.linkedPRs` and flip each sibling draft to ready-for-review via `gh pr ready <url>`. Idempotent: skip siblings already marked ready (don't error).
- Also flip siblings to ready-for-review when the `on-sibling-review` gate activates (before the primary is marked ready). This is the primary path for gated workflows.
- Owner/repo for sibling GitHub API calls derived by parsing `LinkedPR.url` (`github.com/<owner>/<repo>/pull/<n>` regex). No same-org assumption.

### New gate condition

- Extend `GateCondition` in `packages/orchestrator/src/worker/types.ts` with `on-sibling-review`.
- Thread `linkedPRs` through `WorkerContext` (type extension) so the gate evaluator has access without coupling to the workflow engine's state-file format.
- Gate is satisfied when every PR in `linkedPRs` has `reviewDecision === 'APPROVED'` (via `gh pr view --json reviewDecision`). Uses GitHub-native review state, not labels — sibling repos don't carry speckit labelsets.
- Gate immediately satisfied when `linkedPRs` is empty (no-op for single-repo workflows).

### Multi-gate-per-phase support

- Refactor `checkGate()` in `gate-checker.ts`: change `find` to `filter` and iterate all matching gates for a phase. Both gates must be satisfied before the phase proceeds.
- `waiting-for:implementation-review` (condition: `always`) and `waiting-for:sibling-review` (condition: `on-sibling-review`) become independently enable-able with distinct gate labels.

## Out of Scope

- Coordinated **merge** across PRs. Reviewers approve; humans merge. Auto-merge in dependency order is a separate, larger feature.
- Cross-repo CI status aggregation ("don't approve until all sibling CIs are green"). Reviewers see CI status on each PR individually.
- Re-syncing PR titles/descriptions when the primary changes — see Issue E out-of-scope.

## User Stories

### US1: Multi-repo review coordination

**As a** developer working on a multi-repo feature,
**I want** all sibling PRs to automatically become ready-for-review when the primary PR enters review,
**So that** reviewers can see and approve all related changes without manual intervention.

**Acceptance Criteria**:
- [ ] When the primary PR is marked ready-for-review, all linked sibling PRs are also marked ready-for-review
- [ ] Siblings already marked ready are skipped without error

### US2: Sibling review gate

**As a** project maintainer,
**I want** the workflow to pause until all linked sibling PRs are approved,
**So that** the primary workflow doesn't proceed until cross-repo changes are fully reviewed.

**Acceptance Criteria**:
- [ ] A workflow with `on-sibling-review` gate pauses until all sibling PRs have `reviewDecision === 'APPROVED'`
- [ ] A workflow with no linked PRs and the `on-sibling-review` gate proceeds immediately (no-op)
- [ ] The `waiting-for:sibling-review` label is applied while waiting and removed when all siblings are approved

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extend `markReadyForReview()` to flip sibling drafts via `gh pr ready <url>` | P1 | Idempotent; skip already-ready siblings |
| FR-002 | Add `on-sibling-review` gate condition checking `reviewDecision === 'APPROVED'` on all `linkedPRs` | P1 | Uses `gh pr view --json reviewDecision` |
| FR-003 | Thread `linkedPRs` through `WorkerContext` for gate evaluation access | P1 | Type extension, not full `WorkflowState` |
| FR-004 | Parse `LinkedPR.url` for owner/repo resolution | P1 | Regex: `github.com/<owner>/<repo>/pull/<n>` |
| FR-005 | Refactor `gate-checker.ts` for multi-gate-per-phase support | P1 | `find` → `filter`, iterate all matching gates |
| FR-006 | Flip siblings to ready-for-review at `on-sibling-review` gate activation | P2 | Primary path for gated workflows |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Sibling PRs flipped to ready-for-review | 100% of linked PRs | Integration test with mock `gh` CLI |
| SC-002 | Gate blocks until all siblings approved | Gate only satisfied when all `reviewDecision === 'APPROVED'` | Unit test with mock responses |
| SC-003 | No-op for single-repo workflows | Gate immediately satisfied when `linkedPRs` is empty | Unit test |

## Assumptions

- `WorkflowState.linkedPRs` is populated by Phase 2 (#691) before Phase 3 logic runs
- `LinkedPR` schema includes `url` field with full GitHub PR URL (parseable for owner/repo)
- GitHub token available in worker context has sufficient permissions for `gh pr ready` and `gh pr view` on sibling repos
- Sibling repos are accessible to the same GitHub credentials as the primary repo

## Dependencies

Hard deps: Issues C (linkedPRs schema) and E (linkedPRs populated).

## Blocks

Nothing; this is the last issue in the planned scope. Follow-on work (cleanup, merge ordering) is deferred.

---

*Generated by speckit*
