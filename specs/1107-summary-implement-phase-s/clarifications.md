# Clarifications: Implement-phase product-diff guard (#1107)

## Batch 1 — 2026-08-18

### Q1: Legitimate agent-context-file-only change
**Context**: FR-001 excludes `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and `.github/copilot-instructions.md` unconditionally. US3's second acceptance criterion explicitly defers the case where an implement phase's *legitimate* product is only an agent-context-file edit (e.g. a bugfix to `CLAUDE.md` itself) — that phase would false-fail under the new guard.
**Question**: When an implement phase's own diff consists solely of agent-context files that are the genuine deliverable, what should happen?
**Options**:
- A: Accept the false failure as documented behavior — the operator resolves it via review/manual advance (`/cockpit:resume` or label surgery). Simplest; matches the fix's safety-net intent.
- B: Provide an explicit escape hatch (mechanism settled at /plan, e.g. a marker in the issue/workflow) so such phases pass without weakening the default.

**Answer**: A — accept the false failure as documented behavior; the operator resolves it via review or manual advance. An explicit escape hatch reintroduces exactly the shape of bypass this bug exploited — a marker that makes an otherwise-empty phase 'count', which a halted agent could plausibly set. For a safety net, fail-closed is the correct bias: a false failure is loud and cheaply recoverable, whereas a false pass is invisible and (in the observed incident) merged a phantom PR whose absent implementation blocked a downstream issue. An implement phase whose genuine sole deliverable is an agent-context file is rare — that is normally docs work, not an implement phase.

### Q2: FR-006 zero-tasks-checked net — ship here or follow-up?
**Context**: FR-006 (fail loudly when the implement phase checks off zero tasks in `tasks.md`) is marked P3 and flagged as a /clarify question. It is an independent third net over the operator-visible symptom, orthogonal to file-path classification.
**Question**: Does FR-006 ship in this fix, or is it deferred to a follow-up issue?
**Options**:
- A: Defer to a follow-up issue — keep this fix focused on the two structural defects (exclusion list + diff window).
- B: Ship it here as a third independent guard.

**Answer**: A — defer FR-006 (zero-tasks-checked net) to a follow-up issue; keep this fix focused on the two structural defects. FR-006 interacts directly with Q5's resume semantics — a resumed increment can legitimately check off zero NEW tasks while finishing prior work — so a naive implementation would false-fail exactly the phases Q5 is trying to protect. It deserves its own design pass. The two structural defects (exclusion list + diff window) each independently catch the observed failure, so deferring FR-006 does not leave the reported bug unfixed.

### Q3: Exact-filename exclusion depth
**Context**: FR-001 specifies exact-match filenames. The spec-kit `update_agent` step writes these files at the **repo root**, but monorepos routinely carry nested agent-context files (e.g. `packages/foo/CLAUDE.md`) that are deliberate product/documentation work.
**Question**: Should the exact-filename exclusion match root-level paths only, or the basename at any depth?
**Options**:
- A: Root-level only (`CLAUDE.md` === exact path). Nested `packages/*/CLAUDE.md` edits count as product code. Matches what `update_agent` actually touches.
- B: Basename match at any depth — any `**/CLAUDE.md` is excluded.

**Answer**: A — root-level exact-path match only; nested `packages/*/CLAUDE.md` edits count as product code. The spec-kit `update_agent` step writes these files at the repo root, so a root-only match is precisely aligned with the actual masking mechanism this fix removes. generacy is itself a monorepo, and a basename match at any depth would widen the excluded set — weakening the guard generally and false-failing genuine nested documentation work. Keep the exclusion exactly as narrow as the defect requires.

### Q4: Base-merge contamination of the phase window
**Context**: FR-002 changes the window to "phase start commit → HEAD". A pre-phase (or between-increment) base merge of `origin/develop` into the branch lands inside that window; the merged-in product files would then satisfy the guard on behalf of a phase that wrote nothing — recreating the exact fail-open defect this fix removes, via a different door.
**Question**: Must the phase-scoped diff be immune to changes introduced by base-branch merges?
**Options**:
- A: Yes — merge-introduced changes must not count (e.g. capture the start ref after the pre-phase merge and/or measure only the phase's own commits; mechanism settled at /plan).
- B: Accept as a documented limitation — base merges landing product files mid-phase are rare enough.

**Answer**: A — yes, the phase-scoped diff must be immune to changes introduced by base-branch merges (capture the start ref after any pre-phase merge and/or measure only the phase's own commits; mechanism settled at /plan). Option B's premise that base merges are 'rare enough' is factually wrong for this system: the orchestrator ships a dedicated base-sync and merge-conflict subsystem (a `waiting-for:merge-conflicts` gate, a `blocked:stuck-merge-conflicts` escalation, an auto-remedy path), so mid-phase base merges are routine. Accepting B would recreate the identical fail-open defect through a different door.

### Q5: Diff window across worker restarts / resume
**Context**: Implement runs in increments and can pause/resume (gates, lease expiry, worker restart). After a resume on a fresh worker, prior increments' commits are already on the branch and a naïvely captured "phase start" ref only covers post-resume work — a resumed phase that finishes by checking off remaining tasks with little new file churn could false-fail.
**Question**: What does "the phase's own diff" mean when the implement phase spans a pause/resume or worker restart?
**Options**:
- A: Post-resume window only is acceptable — stateless (no persisted start ref), small documented false-failure risk on resumed phases; operator overrides via review.
- B: The window must span the whole implement phase including pre-restart increments — requires persisting the phase-start ref (e.g. Redis or a PR/issue marker) across restarts.

**Answer**: B — the window must span the whole implement phase including pre-restart increments; persist the phase-start ref across restarts. The root cause of this bug was measuring the WRONG WINDOW (cumulative branch diff instead of the phase's own work); choosing A would knowingly leave a different wrong-window case in place — the same class of defect with the sign flipped. The persistence infrastructure already exists (every cluster runs a Redis container alongside the orchestrator), so the phase-start ref can be persisted there or as a PR/issue marker without standing up a new store. Pause/resume is common in this workflow (gates, lease expiry, worker restart, ~20-minute fixer CLI timeout), so the resumed-phase false-failure risk under A is not marginal.
