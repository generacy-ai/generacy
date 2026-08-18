# Clarifications: Implement-phase product-diff guard (#1107)

## Batch 1 — 2026-08-18

### Q1: Legitimate agent-context-file-only change
**Context**: FR-001 excludes `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and `.github/copilot-instructions.md` unconditionally. US3's second acceptance criterion explicitly defers the case where an implement phase's *legitimate* product is only an agent-context-file edit (e.g. a bugfix to `CLAUDE.md` itself) — that phase would false-fail under the new guard.
**Question**: When an implement phase's own diff consists solely of agent-context files that are the genuine deliverable, what should happen?
**Options**:
- A: Accept the false failure as documented behavior — the operator resolves it via review/manual advance (`/cockpit:resume` or label surgery). Simplest; matches the fix's safety-net intent.
- B: Provide an explicit escape hatch (mechanism settled at /plan, e.g. a marker in the issue/workflow) so such phases pass without weakening the default.

**Answer**: *Pending*

### Q2: FR-006 zero-tasks-checked net — ship here or follow-up?
**Context**: FR-006 (fail loudly when the implement phase checks off zero tasks in `tasks.md`) is marked P3 and flagged as a /clarify question. It is an independent third net over the operator-visible symptom, orthogonal to file-path classification.
**Question**: Does FR-006 ship in this fix, or is it deferred to a follow-up issue?
**Options**:
- A: Defer to a follow-up issue — keep this fix focused on the two structural defects (exclusion list + diff window).
- B: Ship it here as a third independent guard.

**Answer**: *Pending*

### Q3: Exact-filename exclusion depth
**Context**: FR-001 specifies exact-match filenames. The spec-kit `update_agent` step writes these files at the **repo root**, but monorepos routinely carry nested agent-context files (e.g. `packages/foo/CLAUDE.md`) that are deliberate product/documentation work.
**Question**: Should the exact-filename exclusion match root-level paths only, or the basename at any depth?
**Options**:
- A: Root-level only (`CLAUDE.md` === exact path). Nested `packages/*/CLAUDE.md` edits count as product code. Matches what `update_agent` actually touches.
- B: Basename match at any depth — any `**/CLAUDE.md` is excluded.

**Answer**: *Pending*

### Q4: Base-merge contamination of the phase window
**Context**: FR-002 changes the window to "phase start commit → HEAD". A pre-phase (or between-increment) base merge of `origin/develop` into the branch lands inside that window; the merged-in product files would then satisfy the guard on behalf of a phase that wrote nothing — recreating the exact fail-open defect this fix removes, via a different door.
**Question**: Must the phase-scoped diff be immune to changes introduced by base-branch merges?
**Options**:
- A: Yes — merge-introduced changes must not count (e.g. capture the start ref after the pre-phase merge and/or measure only the phase's own commits; mechanism settled at /plan).
- B: Accept as a documented limitation — base merges landing product files mid-phase are rare enough.

**Answer**: *Pending*

### Q5: Diff window across worker restarts / resume
**Context**: Implement runs in increments and can pause/resume (gates, lease expiry, worker restart). After a resume on a fresh worker, prior increments' commits are already on the branch and a naïvely captured "phase start" ref only covers post-resume work — a resumed phase that finishes by checking off remaining tasks with little new file churn could false-fail.
**Question**: What does "the phase's own diff" mean when the implement phase spans a pause/resume or worker restart?
**Options**:
- A: Post-resume window only is acceptable — stateless (no persisted start ref), small documented false-failure risk on resumed phases; operator overrides via review.
- B: The window must span the whole implement phase including pre-restart increments — requires persisting the phase-start ref (e.g. Redis or a PR/issue marker) across restarts.

**Answer**: *Pending*
