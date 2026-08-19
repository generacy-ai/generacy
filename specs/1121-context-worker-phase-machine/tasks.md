# Tasks: Add `review` and `remediate` to the workflow phase machinery

**Input**: Design documents from `/specs/1121-context-worker-phase-machine/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Canonical vocabulary (single source of truth)

<!-- Everything downstream depends on the WorkflowPhase union widening. Must land first. -->

- [X] T001 [US1] Widen the canonical vocabulary in `packages/orchestrator/src/worker/types.ts`:
  - Add `'review'` and `'remediate'` to the `WorkflowPhase` union (:9).
  - Insert `'review'` into `PHASE_SEQUENCE` between `'implement'` and `'validate'` → `['specify','clarify','plan','tasks','implement','review','validate']` (:50). Do **not** add `remediate` (FR-004).
  - Confirm `WORKFLOW_PHASE_SEQUENCES` `speckit-feature`/`speckit-bugfix` still reference `PHASE_SEQUENCE` by identity; leave `speckit-epic` as its explicit `['specify','clarify','plan','tasks']` literal (FR-003).
  - Add `review: 'implementation'` and `remediate: 'implementation'` to `PHASE_TO_STAGE` (`Record<WorkflowPhase, StageType>`, :80) — must stay exhaustive (FR-002).

## Phase 2: Derived duplication sites

<!-- Phase boundary: complete T001 before starting — every site below references the widened union. -->

- [X] T002 [US1][US3] Update `packages/orchestrator/src/worker/config.ts`:
  - Add `review`, `remediate` to `GateDefinitionSchema.phase` `z.enum` (keep `satisfies readonly WorkflowPhase[]`) (:18).
  - Add `review`/`remediate` optional keys to `PhaseTimeoutOverridesSchema` as `z.number().int().min(60_000).optional()` (:41-49, FR-005).
  - Add `review`, `remediate` to agent-merge `phaseKeys` `as const` array (:225).
  - Add `reviewPhaseEnabled: z.boolean().default(false)` to `WorkerConfigSchema` (:55, D-4/FR-008).
  - Do **NOT** add any default gate for `review` — it ships gate-less (Q2=A/FR-010).
- [X] T003 [P] [US1] Add `review`, `remediate` to `WorkflowPhaseSchema` `z.enum` in `packages/orchestrator/src/worker/pause-context.ts` (:28).
- [X] T004 [US3] Update `packages/orchestrator/src/config/loader.ts`: add `review`, `remediate` to `overridablePhases` `as const` array (:243, keeps `validate` excluded), and read `WORKER_REVIEW_PHASE_ENABLED` env → wire into `reviewPhaseEnabled`. (Depends on T002 for the schema field.)
- [X] T005 [P] [US3] Add `review: AgentEntrySchema.optional()` and `remediate: AgentEntrySchema.optional()` to the `.strict()` `phases` object in `packages/config/src/template-schema.ts` (:40-47, FR-005).
- [X] T006 [P] [US3] Add `review`, `remediate` to `KNOWN_PHASES` in `packages/generacy/src/cli/commands/cockpit/resume.ts` (:54-61).
- [X] T007 [P] [US1] Add `review`, `remediate` to the `CorePhase` union in `packages/workflow-engine/src/types/github.ts` (:190-193).
- [X] T008 [P] [US3] Add the four phase-progress label families for both phases to `WORKFLOW_LABELS` in `packages/workflow-engine/src/actions/github/label-definitions.ts`: `phase:review`, `completed:review`, `failed:review`, `failed:review-repeated` and the `remediate` equivalents (8 entries, FR-006/Q3=A). Add **no** `waiting-for:review`/`waiting-for:remediate` gate labels.

## Phase 3: Phase-loop wiring (stub execution + seams)

<!-- Phase boundary: complete Phase 1 and T002 before starting. -->

- [X] T009 [US1][US2] Apply the three surgical inserts in `packages/orchestrator/src/worker/phase-loop.ts` (plan §phase-loop.ts changes):
  - Add optional `remediateTrigger?: (context: WorkerContext) => boolean` to `PhaseLoopDeps` (default undefined → dead in prod, FR-007/D-5).
  - **Feature-flag skip**: at the top of the `for` body, before `labelManager.onPhaseStart(phase)` (:309), add `if (phase === 'review' && !config.reviewPhaseEnabled) { logger.debug(...); continue; }` (FR-008, SC-004).
  - **Stub executor**: add `private runStubPhase(phase: 'review' | 'remediate'): PhaseResult { return { phase, success: true, exitCode: 0, durationMs: 0, output: [] }; }`; dispatch it via a branch placed **before** `if (phase === 'validate')` in the execute-phase `try` (:449). Tighten the CLI-path cast (:523) to `Exclude<typeof phase, 'validate' | 'review' | 'remediate'>` (D-6).
  - **Off-sequence remediate seam**: after `review` completes successfully, if `remediateTrigger?.(context)` is true, run `onPhaseStart('remediate')` → `runStubPhase('remediate')` → `onPhaseComplete('remediate')`, push the result, then `i--; continue;` to re-enter `review` (reuse `i--` precedent at :702, FR-007/D-5).

## Phase 4: Tests

<!-- Phase boundary: complete Phases 1–3 before starting — the audit reads every widened site. -->

- [ ] T010 [US1] Create `packages/orchestrator/src/__tests__/phase-vocabulary-audit.test.ts` (NEW) following the `label-protocol-audit.test.ts` / `phase-tracker-audit.test.ts` pattern (FR-011/SC-003). Assert per `contracts/audit-test.md`:
  - A1 union contains both phases; A2 `PHASE_SEQUENCE` has `review` at `indexOf('implement')+1` / `indexOf('validate')-1` and no `remediate`.
  - A3 `getPhaseSequence('speckit-feature'|'speckit-bugfix')` has `review` right after `implement`; `getPhaseSequence('speckit-epic')` deep-equals `['specify','clarify','plan','tasks']`; no sequence contains `remediate`.
  - A4 `PHASE_TO_STAGE['review'|'remediate'] === 'implementation'`.
  - A5 every full-vocabulary site (#1–#9 in `contracts/phase-vocabulary.md`) includes both phases (Zod `.options`/`.keyof().options` introspection or `.parse()` accept).
  - A6 LabelManager runtime probe registers `phase:review`/`completed:review`; all four families exist in `WORKFLOW_LABELS` for both phases; **no** `waiting-for:review`/`waiting-for:remediate`.
  - A7 the two launcher `PhaseIntent['phase']` unions (`orchestrator/src/launcher/types.ts`, `generacy-plugin-claude-code/src/launch/types.ts`) do **not** include the new phases — encoded as a documented exclusion set (D-3/A7).
- [ ] T011 [US1][US2] Add a phase-loop unit test (co-located with existing phase-loop tests under `packages/orchestrator/src/worker/__tests__/`) proving:
  - US1 AC4: with `reviewPhaseEnabled=false`, a feature/bugfix run **skips** `review` — no `onPhaseStart('review')`, no `phase:review`/`completed:review` labels (byte-identical behavior).
  - US2 AC1/AC2: with an injected fire-once-then-false `remediateTrigger`, the loop enters `remediate` off-sequence, returns to `review`, and terminates (no infinite loop, eventually advances past `review`).

## Phase 5: Verification & release

- [ ] T012 [US1] Add `.changeset/1121-review-remediate-phase-machinery.md` (NEW file — CI gate): `@generacy-ai/workflow-engine` **minor** (new label vocabulary + `CorePhase` widening), `@generacy-ai/config` **minor** (public `template-schema` phase keys), `@generacy-ai/orchestrator` **patch** (internal plumbing), `@generacy-ai/generacy` **patch** (`resume.ts` `KNOWN_PHASES`). Copy the shape of a comparable existing changeset.
- [ ] T013 [US1] Run `pnpm -r build` and the orchestrator/config/cockpit/launcher/workflow-engine test suites; confirm all green and that `PHASE_TO_STAGE` exhaustiveness / `satisfies readonly WorkflowPhase[]` compile clean (SC-001).

## Dependencies & Execution Order

**Sequential backbone**:
- T001 (canonical union) → all of Phase 2 → T009 (phase-loop) → T010/T011 (tests) → T012/T013 (verify).

**Parallel opportunities within Phase 2** (different files, no shared state):
- T003, T005, T006, T007, T008 can all run in parallel with each other and with T002.
- T004 depends on T002 (needs `reviewPhaseEnabled` on the schema before wiring the env read); its `overridablePhases` edit is otherwise independent.

**Test phase**:
- T010 and T011 both require Phases 1–3 complete. They touch different files and can run in parallel.

**Release**:
- T012 (changeset) can be authored any time after the package list is known (post-T001) but must land in the PR.
- T013 (build + suites) is the final gate — run after everything else.

## Notes

- **Intentional subsets — do NOT widen** (D-3): `orchestrator/src/launcher/types.ts` and `generacy-plugin-claude-code/src/launch/types.ts` `PhaseIntent['phase']` unions stay as-is; T010/A7 pins them as documented exclusions.
- **Behavior-identity invariant** (FR-009/SC-004): with `reviewPhaseEnabled=false` and `remediateTrigger=undefined`, feature/bugfix/epic runs are byte-identical to pre-change.
- No `packages/claude-plugin-cockpit/commands/*.md` files are edited by this issue → no playbook re-pin task required.
- No `.specify/memory/constitution.md` present → constitution check skipped.
