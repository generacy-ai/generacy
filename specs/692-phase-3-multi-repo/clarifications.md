# Clarifications for #692: Phase 3 Multi-Repo

## Batch 1 — 2026-05-22

### Q1: Gate condition evaluation — where does `linkedPRs` come from?
**Context**: The `on-sibling-review` gate condition needs access to `WorkflowState.linkedPRs` to check approval labels on sibling PRs. However, the current gate evaluation in `phase-loop.ts` (lines 403-425) operates on `context` which is a `WorkerContext` — not directly on `WorkflowState`. The `on-questions` condition uses file-based checks (`hasPendingClarifications`), but `on-sibling-review` needs in-memory workflow state.
**Question**: How should the gate evaluation access `linkedPRs`? Options:
- A: Read `WorkflowState` from the state file on disk (same pattern as step outputs)
- B: Thread `WorkflowState` through `WorkerContext` (requires type extension)
- C: Pass `linkedPRs` as a separate parameter to the gate evaluation block

**Answer**: *Pending*

### Q2: Approval label name on sibling repos
**Context**: The spec says the gate checks "every PR in `linkedPRs` for the approval label" (FR-002). The assumption states "the approval label name on sibling repos matches the primary repo convention." But the spec doesn't define what specific label constitutes "approved." Is it a GitHub review approval state (via `gh pr view --json reviewDecision`), or a specific label string like `approved` or `completed:implementation-review`?
**Question**: What constitutes "approved" for a sibling PR — a GitHub review approval state (`APPROVED` reviewDecision), or a specific label (and if so, which label name)?

**Answer**: *Pending*

### Q3: Ready-for-review sync timing
**Context**: The spec says ready-for-review sync should "hook into the existing `prManager.markReadyForReview()` call path" and "when the review phase begins." But `markReadyForReview()` is called after workflow completion (all phases done), not at the start of the review phase. It runs in `claude-cli-worker.ts` after the phase loop exits. The review gate pauses the workflow *during* the implement phase, before `markReadyForReview()` is ever called.
**Question**: Should sibling PRs be flipped to ready-for-review:
- A: When `markReadyForReview()` fires on the primary (after all phases complete) — extends existing method
- B: When the `on-sibling-review` gate activates (during implement phase, before primary is marked ready) — would need a separate trigger
- C: Both — siblings flipped at gate activation, primary flipped at workflow completion as today

**Answer**: *Pending*

### Q4: Sibling PR owner/repo resolution
**Context**: `LinkedPR` has `repo` (short name like "generacy-cloud"), `number`, `branch`, and `url`. To call GitHub API for label checks (`gh pr view`) or marking ready (`gh pr ready`), we need `owner/repo`. The spec assumes "same GitHub organization" (Assumption 4). Should we parse `url` for owner/repo, or hardcode the owner from the primary PR's owner?
**Question**: Should sibling repo owner be derived by parsing `LinkedPR.url`, or by reusing `context.item.owner` (assuming same org)?

**Answer**: *Pending*

### Q5: Gate placement — same phase as implementation-review or separate?
**Context**: The spec says to add the gate to `speckit-feature` config at `{ phase: 'implement', gateLabel: 'waiting-for:sibling-review', condition: 'on-sibling-review' }`. This means two gates fire on the same `implement` phase: `waiting-for:implementation-review` (condition: `always`) and `waiting-for:sibling-review` (condition: `on-sibling-review`). The current `checkGate()` in `gate-checker.ts` returns only the **first matching gate** for a phase. Multiple gates per phase are not supported.
**Question**: Should `on-sibling-review` be a separate gate entry (requiring multi-gate-per-phase support in gate-checker), or should it be folded into the existing `waiting-for:implementation-review` gate as an additional condition?

**Answer**: *Pending*
