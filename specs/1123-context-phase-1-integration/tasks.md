# Tasks: Review/remediate foundations wired end-to-end (stub executors)

**Input**: Design documents from `/specs/1123-context-phase-1-integration/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/remediate-review-seam.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Scope note

This issue ships **tests + a shipped contract note only** — no product behavior (FR-008). Every
`packages/*/src/` change is a `*.test.ts` file (changeset gate test-only exemption applies) and the
contract doc lives under `specs/`. **Do NOT add a `.changeset/*.md`** (research.md Decision 6).

---

## Phase 1: Preconditions (BLOCKING — Q1=B)

<!-- The implement phase MUST NOT start until Phase 1 is fully green. -->

- [ ] T001 Confirm **#1121** (phase machinery) is merged to `develop`: `WorkflowPhase` includes
  `review` and `remediate`, all companion enumerations updated (`PHASE_SEQUENCE` /
  `WORKFLOW_PHASE_SEQUENCES` `types.ts:50,58`, `PHASE_TO_STAGE` `types.ts:80`, `pause-context.ts`
  `WorkflowPhaseSchema` `:28`, `config.ts` `GateDefinitionSchema.phase`), AND the **off-sequence
  loop-control entry mechanism** exists (a step outcome `{ next: <phase> }` the loop reads and jumps
  on). If the mechanism is missing, STOP — this is Integration Risk 1; coordinate scope with #1121
  before proceeding (do not build it here).
- [ ] T002 Confirm **#1122** (per-workflow config) is merged to `develop`: `maxRemediations`
  (feature 3 / bugfix 2) + review profile live in `@generacy-ai/config` `OrchestratorSettings`
  (`packages/config/src/template-schema.ts`), resolvable via the `worker/config.ts` resolver.
  Record the resolver's exact function name/signature (Integration Risk 3) — tests read through it,
  not a re-derived path.
- [ ] T003 Rebase this branch on `origin/develop` (`git fetch origin && git rebase origin/develop`)
  and verify the union expanded:
  `grep -n "type WorkflowPhase" packages/orchestrator/src/worker/types.ts` shows `review` +
  `remediate`.
- [ ] T004 [P] Verify build + baseline suite green post-rebase:
  `pnpm install && pnpm --filter @generacy-ai/orchestrator build && pnpm --filter @generacy-ai/orchestrator test worker`.

## Phase 2: Test harness foundation

<!-- Shared scaffolding all three test files build on. Complete before Phase 3-5. -->

- [ ] T005 Study the existing harness pattern in
  `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts:42-116`
  (`createMockDeps()` / `createMockContext()` / `createConfig()` injecting `PhaseLoopDeps`) and the
  `PhaseLoopDeps` / `WorkerContext` / `WorkerConfig` seams at `phase-loop.ts:62-100`. Identify the
  injection point stub review/remediate executors plug into (the same seam `cliSpawner.spawnPhase`
  uses — research.md Decision 1). No file written in this task; it grounds T006-T011.

## Phase 3: US1 — Loop traverses review and remediate (FR-001/002/003/004)

**Story goal**: Prove the loop sequences `review` after `implement`, reaches `remediate`
off-sequence and backtracks to a re-`review`, and surfaces per-workflow config in-loop.

**File**: `packages/orchestrator/src/worker/__tests__/phase-loop.review-remediate.integration.test.ts` (NEW)

- [ ] T006 [US1] Create the integration test file and set up a **stub** review/remediate executor
  injected through the `PhaseLoopDeps` seam, returning a **controllable** loop-control outcome so the
  harness can steer: first `review` pass → `{ next: 'remediate' }`; `remediate` → `{ next: 'review' }`;
  second `review` pass → advance (FR-001, research.md Decision 1). Stubs are test-only doubles — no
  production executor files ship.
- [ ] T007 [US1] Assert for **`speckit-feature`**: the loop schedules `review` immediately after
  `implement` (FR-002, SC-002).
- [ ] T008 [US1] Assert for **`speckit-bugfix`**: the loop schedules `review` immediately after
  `implement` (FR-002, SC-002).
- [ ] T009 [US1] Assert `remediate` is reachable **off the linear sequence** via `{ next: 'remediate' }`
  and, on completion, control returns to a `review` pass — **not** the next linear phase
  (FR-003, SC-002). Assert the invariant behaviorally (entry only via loop control; always backtracks
  to review).
- [ ] T010 [US1] Populate `OrchestratorSettings` with feature=3 / bugfix=2 `maxRemediations` + a
  distinct review profile per workflow, and assert both are **readable inside the loop** via the held
  config object resolved through the `worker/config.ts` resolver (T002) — not a new `WorkerConfig`
  field, not an injected loop dep (FR-004, Q4=B, SC-003). Assert the values differ per workflow.
- [ ] T011 [US1] Assert **negative scope** (FR-008): no real review/remediation behavior, no PR
  posting, no severity gating, no CI/validate orchestration is exercised by the stubs.

## Phase 4: US2 — Pause/resume survives the new phases (FR-005)

**Story goal**: Pause/resume of `review` and `remediate` round-trips to the correct phase with
symmetric label apply/clear and no stranding.

**File**: `packages/orchestrator/src/worker/__tests__/pause-resume.review-remediate.test.ts` (NEW)

- [ ] T012 [US2] Create the pause/resume test file. Drive
  `writePauseContext(workdir, workflowId, { phase: 'review', … })` then `readPauseContext(...)` and
  assert readback resolves to `review` (autonomous phase — sidecar path, no gate). This directly
  exercises companion #3 (`pause-context.ts` `WorkflowPhaseSchema`) — the test fails if the z.enum
  omits the phase (FR-005, SC-004).
- [ ] T013 [US2] Same round-trip for `phase: 'remediate'` — assert resume resolves back to
  `remediate` (re-enter the remediation step, Q3=A — NOT `review`) (FR-005, SC-004).
- [ ] T014 [US2] Assert `labelManager` applies then clears the `waiting-for:*` / `phase:*` / `agent:*`
  labels **symmetrically** across the pause/resume for both phases — 0 residual labels afterward
  (SC-004). **Name-agnostic** per PD-4: assert entries exist and round-trip, not specific label
  strings.

## Phase 5: US3 — Phase-union sync audit (FR-006)

**Story goal**: A mutation-sensitive test that fails if any companion enumeration drifts from the
`WorkflowPhase` union.

**File**: `packages/orchestrator/src/worker/__tests__/types.test.ts` (EXTEND — do not duplicate)

- [ ] T015 [US3] Establish the runtime source-of-truth phase keyset for the audit (a TS union has no
  runtime members): seed from `PHASE_TO_STAGE`'s keyset (total by construction) or an `ALL_PHASES`
  constant #1121 exports — whichever #1121 actually delivers (research.md Decision 5).
- [ ] T016 [US3] Extend `types.test.ts`: assert every `WorkflowPhase` appears in `PHASE_SEQUENCE`
  (feature/bugfix sequences) and every sequence member is a `WorkflowPhase`; assert every phase is a
  key in `PHASE_TO_STAGE` (belt-and-suspenders alongside `tsc`). Note `remediate` is off-sequence —
  keep it in the keyset via the T015 source-of-truth, not the linear sequence.
- [ ] T017 [US3] Assert `pause-context.ts` `WorkflowPhaseSchema.options` **set-equals** the keyset,
  and `config.ts` `GateDefinitionSchema.phase` z.enum options **set-equal** the keyset — the two
  hand-maintained runtime duplicates `tsc` does not enforce. (`GATE_MAPPING` is **exempt** — keyed by
  gate label, not total over phase.)
- [ ] T018 [US3] Mutation check (SC-005): by hand during review, drop `review`/`remediate` from one
  companion (e.g. `pause-context.ts` `WorkflowPhaseSchema`), confirm the audit turns **red**, then
  revert. Record the result in the PR description.

## Phase 6: Contract note (FR-007)

- [ ] T019 Verify/finalize the shipped contract at
  `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md` (already drafted). It
  MUST pin: off-sequence `{ next: 'remediate' }` entry; the always-`{ next: 'review' }` backtrack;
  resume targets (`review→review`, `remediate→remediate`, Q3=A); and the per-workflow config surface
  (Q4=B) (FR-007, SC-006). Do NOT add a load-bearing comment to `phase-loop.ts` — that would make the
  diff a non-test `src/` change requiring a changeset (research.md Decision 6). Keep the contract in
  `specs/`.

## Phase 7: Verification

- [ ] T020 Run all three suites green (SC-001):
  `pnpm --filter @generacy-ai/orchestrator test phase-loop.review-remediate.integration`,
  `... test pause-resume.review-remediate`, `... test types.test`. Then confirm **no** `.changeset/*.md`
  was added and `git diff --stat` shows only `*.test.ts` files under `packages/*/src/` plus the
  `specs/` contract doc.

## Dependencies & Execution Order

**Phase 1 (Preconditions) is a hard gate** — Q1=B blocks the implement phase until #1121 and #1122
land on `develop` and this branch is rebased (T001-T004). Do not start Phase 2+ until T003 confirms
the union expanded and T001 confirms the loop-control mechanism exists.

**Sequential phases**: Phase 1 → Phase 2 → (Phase 3, 4, 5 in parallel) → Phase 6 → Phase 7.

**Parallel opportunities**:
- T004 [P] runs alongside T001-T003 verification.
- Phases 3, 4, and 5 each touch a **different file**
  (`phase-loop.review-remediate.integration.test.ts`, `pause-resume.review-remediate.test.ts`,
  `types.test.ts`) and have no cross-dependencies — they can be developed in parallel once Phase 2
  (T005) grounds the harness pattern. Within each phase, tasks share one file and run sequentially.
- T019 (contract) is independent of the test phases and can proceed any time after Phase 1.

**Verification (T018 mutation check, T020 suite run)** waits for its story's tests to be written.
