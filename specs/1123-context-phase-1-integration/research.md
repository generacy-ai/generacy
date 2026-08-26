# Research: Review/remediate foundations wired end-to-end (#1123)

All decisions are grounded in the current code on this branch (pre-#1121/#1122) and the resolved clarifications (Batch 1, 2026-08-19).

## Decision 1 — Where the stub review/remediate executors plug in

**Decision**: Inject stubs through the existing `PhaseLoopDeps` seam, exactly as `cliSpawner`/`labelManager`/`gateChecker` are injected today (`__tests__/phase-loop.test.ts:42-73`). No production executor files ship (spec Assumption §89).

**Rationale**: The phase loop already dispatches phase execution through injected deps (`cliSpawner.spawnPhase` for CLI phases, `runValidatePhase` for validate — `phase-loop.ts:211`, `:448-615`). Review/remediate stubs slot into the same seam. Tests get a controllable verdict/outcome to steer loop control (FR-001).

**Alternatives considered**: A separate harness package (`Explore` noted this pattern is rejected elsewhere for one-test-file overhead); a new dedicated loop dependency for the stub (Q4=C — rejected as unnecessary plumbing).

## Decision 2 — Loop-control entry into `remediate` (Q2=C)

**Decision**: `remediate` is entered off-sequence via a **direct loop-control return value** — a discriminated step outcome `{ next: 'remediate' }`, independent of any review verdict. On completion, `remediate` returns `{ next: 'review' }` (always backtrack). This is the seam-of-record (FR-007) documented in `contracts/remediate-review-seam.md`.

**Rationale**: The design has three future remediate entry points (review verdict, validate failure, external PR feedback) all converging on "entered only via loop control." A general discriminated outcome is reusable by P3 (which absorbs validate-fix + pr-feedback). A review-verdict-only trigger (Q2=A) serves one path; a `waiting-for:remediation` gate (Q2=B) needs a label #1121 Q3=A does not add.

**Current-code note**: `phase-loop.ts` advances by index only (`for (i = startIndex; …; i++)`, `:275`) and its result discriminator (`PhaseLoopStatus`, `:111`) has no off-sequence `next` outcome. The mechanism that reads `{ next }` and jumps is **phase machinery expected from #1121** (Integration Risk 1 in plan.md). #1123 asserts the behavior and pins the contract; it does not build the mechanism (Q1=B).

## Decision 3 — Resume target for a mid-`remediate` pause (Q3=A)

**Decision**: Resume to **`remediate`** (re-enter the remediation step), via the phase-agnostic pause-context sidecar. Resume to `review` (Q3=B) is rejected.

**Rationale**: The design doc's remediation-limit gate specifies "human answer resumes into remediate and resets the counter"; remediate must be resumable and partial-work-safe. Re-reviewing incomplete work is design-wrong. The pause-context sidecar (`pause-context.ts`) already resumes the exact interrupted phase (merge-conflict precedent, #902) — it carries the phase in-band, so no `GATE_MAPPING` entry is needed for the sidecar path.

## Decision 4 — Stage + gate naming (Q5=C, resolved here)

**Decision**:
- `review` and `remediate` both map to the **`implementation`** stage (#1121 FR-002; `PHASE_TO_STAGE` is a total Record so #1121 must add these to compile). No new `StageType`.
- `review` is **autonomous — no gate label, no `GATE_MAPPING` entry**. Pause/resume rides the sidecar.
- `remediate` pause/resume also rides the sidecar → resumes to `remediate`. The intended P3 human-gate label is `waiting-for:remediation-limit` (documented, **not** wired/enforced here).
- FR-005 tests assert behavior + label symmetry, **not** specific label strings.

**Rationale**: Q5 option B (new `StageType`) contradicts #1121 FR-002; option A invents a `waiting-for:review` gate the design explicitly rejects (review is autonomous). C avoids re-deciding #1121's stage assignment and avoids hardcoding design-wrong / upstream-owned label names.

## Decision 5 — FR-006 audit must cover runtime z.enum duplicates

**Decision**: The union-sync audit (extending `types.test.ts`) asserts, in addition to sequence coverage:
- `pause-context.ts` `WorkflowPhaseSchema.options` set-equals the `WorkflowPhase` keyset.
- `config.ts` `GateDefinitionSchema` phase `z.enum` options set-equal the `WorkflowPhase` keyset.

**Rationale**: These two runtime enums (`pause-context.ts:28-35`, `config.ts GateDefinitionSchema`) are hand-maintained duplicates of the union that `tsc` does **not** enforce. FR-005's round-trip silently breaks if #3 omits a phase (`readPauseContext` → `null` → fail-loud → stranding). Making them audited turns drift into a red test (SC-005) — the exact bug class US3 targets.

**Runtime source-of-truth**: A TS union has no runtime members. The audit seeds from a total structure — either `PHASE_TO_STAGE`'s keyset (total by construction) or an `ALL_PHASES` constant #1121 should export — and asserts the four other companions equal it.

## Decision 6 — Contract note format (FR-007)

**Decision**: Ship the contract as `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md`. Optionally add a one-line load-bearing comment in `phase-loop.ts` cross-linking it, but keep the doc as the primary artifact.

**Rationale**: Keeping the contract in `specs/` (not `packages/*/src/`) keeps the diff **changeset-free** (all `packages/*/src/` changes are test-only → gate exemption). A doc-only contract is unambiguously within Q1=B's "only tests + the contract note." Adding the comment would make the diff a non-test `src/` change requiring a `patch` changeset.

## Decision 7 — Test file naming

**Decision**: `phase-loop.review-remediate.integration.test.ts` (loop traversal + config) and `pause-resume.review-remediate.test.ts` (round-trip); extend the existing `types.test.ts` for the audit.

**Rationale**: Matches the repo's `phase-loop.<feature>.test.ts` convention (`phase-loop.product-diff.test.ts`, `phase-loop.merge.test.ts`) and the `.integration.test.ts` suffix used for cross-component loop tests.

## Key sources

- Spec + clarifications: `specs/1123-context-phase-1-integration/{spec,clarifications}.md`.
- Phase loop: `packages/orchestrator/src/worker/phase-loop.ts`.
- Phase types/companions: `packages/orchestrator/src/worker/types.ts`.
- Gate/resume: `packages/orchestrator/src/worker/phase-resolver.ts`.
- Pause sidecar: `packages/orchestrator/src/worker/pause-context.ts`.
- Worker config: `packages/orchestrator/src/worker/config.ts`.
- Per-workflow config home: `packages/config/src/template-schema.ts` (`OrchestratorSettings`).
- Test harness precedent: `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts`.
