# Clarifications: Plan-phase commit must not carry repo-root agent-context files

## Batch 1 — 2026-08-28

### Q1: Phase scope of the exclude-and-revert
**Context**: FR-004 scopes the behavior to the `plan` phase only, and Out of Scope lists review/validate/PR-prep/ready-for-review/implement. But the other spec-stage phases (`specify`, `clarify`, `tasks`) run agent prompts and commit through the same `commitAndPush` path — a prompt regression in any of them could equally commit `CLAUDE.md`. The condition is either `phase === 'plan'` or a set of phases.
**Question**: Should the exclude-and-revert apply strictly to `plan`, or to all spec-stage phases (`specify`, `clarify`, `tasks`, `plan`), with only implement-and-later preserved?
**Options**:
- A: Strictly `plan` — it is the only phase whose prompt historically carried the "Update agent context files" instruction.
- B: All spec-stage phases (`specify`, `clarify`, `tasks`, `plan`) — same belt-and-suspenders rationale applies; implement-and-later still preserved.

**Answer**: B — all spec-stage phases (`specify`, `clarify`, `tasks`, `plan`), with implement-and-later preserved. No spec-stage phase has a legitimate reason to edit repo-root agent-context files — they produce `specs/` artifacts. Broadening costs nothing and preserves the one case that matters (implement-phase edits, which can be genuine durable guidance and are already excluded from the empty-diff guard). Since the point of this guard is to survive a *future* prompt regression, scoping it to the single prompt being fixed today defeats its purpose. (@christrudelpw, 2026-08-28)

### Q2: Agent-made direct commits during the plan phase
**Context**: `commitAndPush` also handles the case where "the phase already committed directly" (unpushed commits made by the agent itself). Filtering `toStage` does nothing for that path: if the plan agent runs `git commit` itself and includes `CLAUDE.md`, the file reaches the pushed commit untouched. Guarding it would require inspecting/rewriting agent-made commits, which is a materially bigger design.
**Question**: Is the staging-filter (engine-made commit) the intended scope, with agent-made direct commits during plan explicitly out of scope — or must the guard also cover files inside commits the plan agent created itself?
**Options**:
- A: Staging filter only — agent-made direct commits are out of scope (speckit plan agents don't normally commit; document the limitation).
- B: Also inspect unpushed plan-phase commits and strip/revert agent-context files from them before push.

**Answer**: A — staging filter only; agent-made direct commits are out of scope, document the limitation. Rewriting commits before push is materially riskier than declining to stage a file — a bug there corrupts the branch rather than merely leaking a file. This guard is defense-in-depth (agency#511 removes the instruction that causes the write), so it should be the boring, safe half of the pair. Document the limitation in the code comment beside the filter. (@christrudelpw, 2026-08-28)

### Q3: Plan commit emptied by the exclusion
**Context**: If the only dirty paths at plan completion are agent-context files, the filtered `toStage` is empty and `commitAndPush` returns `no-changes` — the phase completes with no commit. Under #1107 the product-diff guard exists precisely because a CLAUDE.md-only diff signals a misbehaving phase.
**Question**: When the exclusion empties the plan commit entirely, should the phase proceed as a normal `no-changes` outcome (plus the revert warning), or be treated as a failure/flagged condition?
**Options**:
- A: Proceed as `no-changes` with the warning log — the plan phase's own success criteria (plan.md produced) will catch a genuinely empty plan elsewhere.
- B: Treat as an error — an all-excluded diff means the phase produced nothing but agent-context bloat and should fail loudly.

**Answer**: A — proceed as a normal `no-changes` outcome with the warning log. The engine already tolerates a no-change plan phase — only `implement` is in `PHASES_REQUIRING_CHANGES` (`phase-loop.ts`). Promoting this to an error introduces a new pipeline-blocking failure mode beyond this issue's scope and could strand issues; the warning log already gives the operator the signal. (@christrudelpw, 2026-08-28)

### Q4: Replacement for the removed Layer-1 guard
**Context**: FR-005 allows "remove the dead grep (or repoint it at a path the worker actually executes)". AC for US2 only requires that the test stops asserting on `operations/plan.ts`. After removal, the engine-side invariant is enforced behaviorally by the new pr-manager unit tests (SC-001); there would be no static Layer-1 grep left in this repo.
**Question**: Is deleting the dead grep plus behavioral pr-manager unit tests sufficient, or should a new engine-side static guard be added (e.g., a test asserting `pr-manager.ts` wires `EXCLUDED_EXACT_PATHS` into the plan-phase filter) to occupy the Layer-1 slot?
**Options**:
- A: Delete the grep; behavioral unit tests are the engine-side enforcement (prompt-side Layer 1 lives in agency).
- B: Delete the grep and add a new static Layer-1 test over `pr-manager.ts` so the layered-defense structure documented in the #899 contract is preserved in-repo.

**Answer**: A — delete the dead grep; behavioral pr-manager unit tests are the engine-side enforcement, with the prompt-side pin living in agency. The lesson of #899 is precisely that a static grep pointed at the wrong file produces false confidence while the regression runs free. A behavioral test exercising the real commit path is strictly stronger evidence than a string-match over source. A new static guard over `pr-manager.ts` would re-create the same brittle, low-value shape the behavioral tests already cover. (@christrudelpw, 2026-08-28)
