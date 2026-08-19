# Implementation Plan: Add `review` and `remediate` to the workflow phase machinery

**Feature**: Add `review` (linear, after `implement`) and `remediate` (off-sequence) phases to the worker phase machine — type/config/label plumbing + stub execution wiring only.
**Branch**: `1121-context-worker-phase-machine`
**Issue**: generacy-ai/generacy#1121 | **Epic**: generacy-ai/generacy#1120
**Status**: Complete

## Summary

The worker phase machine is a serial `WorkflowPhase` sequence (`specify → clarify → plan → tasks → implement → validate`) whose canonical source is `packages/orchestrator/src/worker/types.ts`, hand-duplicated as Zod enums / literal unions / strict keys across ~10 sites in five packages. This change adds two phases:

- **`review`** — inserted into `PHASE_SEQUENCE` immediately after `implement` (before `validate`), so `speckit-feature`/`speckit-bugfix` gain it; `speckit-epic` keeps its own explicit sequence and is untouched. `review` is **feature-flagged OFF by default** (`WorkerConfig.reviewPhaseEnabled`), so a live run *skips* it before any label/comment/journal side effect — guaranteeing byte-identical observable behavior (Clarifications Q1=A, FR-008).
- **`remediate`** — a first-class phase that appears in **no** linear sequence (FR-004). The phase loop gains an off-sequence seam (execute-then-`i--`-back-to-`review`) driven by an **injectable predicate that defaults to never firing**, so it is dead in production and reachable **only** via the unit test (Clarifications Q4=A, FR-007).

Both phases get stub executors returning success, full phase-progress label families (`phase:`/`completed:`/`failed:`/`failed:*-repeated`, Q3=A/FR-006), and config-schema acceptance (timeout + agent keys, FR-005). The existing `waiting-for:implementation-review` gate stays on `implement`, unchanged (Q2=A/FR-010). A committed exhaustiveness audit test enumerates the duplication sites and fails on drift (Q5=A/FR-011).

After this change: `pnpm -r build` + all suites green; existing feature/bugfix/epic runs behavior-identical; the two new phases inert.

## Technical Context

- **Language / runtime**: TypeScript (ESM), Node ≥22, pnpm workspace monorepo.
- **Validation**: Zod schemas for all config surfaces.
- **Test**: Vitest. Audit-test precedent: `packages/orchestrator/src/__tests__/label-protocol-audit.test.ts`, `phase-tracker-audit.test.ts`.
- **Packages touched**: `@generacy-ai/orchestrator`, `@generacy-ai/config`, `@generacy-ai/workflow-engine`, `@generacy-ai/generacy`. (`generacy-plugin-claude-code` and orchestrator `launcher/types.ts` **intentionally not** touched — see Decision D-3.)

## Canonical model (single source of truth)

`packages/orchestrator/src/worker/types.ts`:

- `WorkflowPhase` union → add `'review' | 'remediate'`.
- `PHASE_SEQUENCE` → `['specify','clarify','plan','tasks','implement','review','validate']` (insert `review` before `validate`; **no** `remediate`).
- `WORKFLOW_PHASE_SEQUENCES` → `speckit-feature`/`speckit-bugfix` keep referencing `PHASE_SEQUENCE` (inherit `review`); `speckit-epic` stays the explicit `['specify','clarify','plan','tasks']` (FR-003).
- `PHASE_TO_STAGE` (`Record<WorkflowPhase, StageType>`, must stay exhaustive) → add `review: 'implementation'`, `remediate: 'implementation'` (FR-002).

Every other site is a *derived* duplication that must include the two new members to satisfy the audit + the compiler.

## Project structure / edit sites

| # | File (package) | Edit |
|---|---|---|
| 0 | `orchestrator/src/worker/types.ts` | Canonical: union, `PHASE_SEQUENCE`, `PHASE_TO_STAGE` (above) |
| 1a | `orchestrator/src/worker/config.ts` `GateDefinitionSchema` enum (:18) | Add `review`, `remediate` (keeps `satisfies readonly WorkflowPhase[]`) |
| 1b | `…/config.ts` `PhaseTimeoutOverridesSchema` (:41-49) | Add `review`, `remediate` as `z.number().int().min(60_000).optional()` (FR-005) |
| 1c | `…/config.ts` default gates (:89-107) | **No change** — `review` ships gate-less (Q2=A/FR-010) |
| 1d | `…/config.ts` agent-merge `phaseKeys` (:225) | Add `review`, `remediate` |
| 1e | `…/config.ts` `WorkerConfigSchema` (:55) | Add `reviewPhaseEnabled: z.boolean().default(false)` |
| 2 | `orchestrator/src/worker/pause-context.ts` `WorkflowPhaseSchema` (:28) | Add `review`, `remediate` |
| 3 | `orchestrator/src/config/loader.ts` `overridablePhases` (:243) + env | Add `review`, `remediate`; read `WORKER_REVIEW_PHASE_ENABLED` |
| 4 | `config/src/template-schema.ts` `phases` strict keys (:40-47) | Add `review`, `remediate` optional `AgentEntrySchema` (FR-005) |
| 5 | `generacy/…/cockpit/resume.ts` `KNOWN_PHASES` (:54-61) | Add `review`, `remediate` |
| 6 | `workflow-engine/src/types/github.ts` `CorePhase` (:192-198) | Add `review`, `remediate` |
| 7 | `workflow-engine/…/label-definitions.ts` `WORKFLOW_LABELS` | Add `phase:`/`completed:`/`failed:`/`failed:*-repeated` for both (FR-006) |
| 8 | `orchestrator/src/worker/phase-loop.ts` | Feature-flag skip + stub executor + remediate seam (FR-007/FR-008) |
| 9 | `orchestrator/src/__tests__/phase-vocabulary-audit.test.ts` (NEW) | Enumerate sites, fail on drift (FR-011) |
| — | `orchestrator/src/launcher/types.ts` (:32) & `generacy-plugin-claude-code/src/launch/types.ts` (:27) | **No change** (Decision D-3) |

### phase-loop.ts changes (three surgical inserts)

1. **Feature-flag skip** — at the top of the `for` body (before `labelManager.onPhaseStart(phase)` at :309), insert:
   `if (phase === 'review' && !config.reviewPhaseEnabled) { logger.debug(...); continue; }`
   Placed pre-side-effect so zero labels/comments/journal fire (FR-008, SC-004).
2. **Stub executor** — in the execute-phase `try` (:449), add a branch **before** `if (phase === 'validate')`:
   `if (phase === 'review' || phase === 'remediate') { result = this.runStubPhase(phase); }`.
   `runStubPhase` returns `{ phase, success: true, exitCode: 0, durationMs: 0, output: [] }`. Update the CLI-path cast at :523 to `Exclude<typeof phase, 'validate' | 'review' | 'remediate'>` so the compiler proves the CLI spawn never sees the new phases.
3. **Off-sequence remediate seam** — after `review` completes successfully, gate on an injectable `PhaseLoopDeps.remediateTrigger?(context): boolean` (default `undefined`): when true, run `labelManager.onPhaseStart('remediate')` → `runStubPhase('remediate')` → `labelManager.onPhaseComplete('remediate')`, push the result, then `i--; continue;` to re-enter `review` (reusing the `i--` backtrack precedent at :702). Predicate defaults to never firing → dead in production (FR-004/Q4=A); the unit test injects a fire-once-then-false predicate to prove entry, return-to-`review`, and termination (US2 AC1/AC2).

## Constitution check

No `.specify/memory/constitution.md` present in the repo; skipped. Changes respect existing patterns: single-source-of-truth vocabulary, Zod-validated config, additive labels, injectable-seam test reachability, and the established audit-test pattern.

## Key decisions (see research.md)

- **D-1**: `PHASE_SEQUENCE` itself gains `review` (not a per-workflow override), because `speckit-feature`/`bugfix` reference it directly and the label-protocol audit iterates `PHASE_SEQUENCE` — matching Clarifications Q3's stated assumption that `phase:review`/`completed:review` become live.
- **D-2**: `review` sits **between** `implement` and `validate` (spec: "immediately after `implement`").
- **D-3**: The two launcher `PhaseIntent['phase']` unions are **left unchanged**, diverging from the spec's Context enumeration. They already exclude `validate` — they enumerate *provider-launchable CLI* phases, and `PHASE_TO_COMMAND` is `Record<PhaseIntent['phase'], string>` (constants.ts:7); widening would force fake `/speckit:review` + `/speckit:remediate` command strings. Neither stub constructs a `PhaseIntent`, so the runtime value set is unchanged. The audit test encodes these (plus the timeout/overridable-phase lists) as intentional subsets.
- **D-4**: Feature flag via `WorkerConfig.reviewPhaseEnabled` (default false) + `WORKER_REVIEW_PHASE_ENABLED` env, over a scattered per-callsite carve-out (Q1=A rejected option C).

## Out of scope

Real executors/prompts/verdict logic, concrete `remediate` triggers, gate migration, any `speckit-epic` sequence change, cloud/cluster-base companions.

## Changeset

`.changeset/1121-review-remediate-phase-machinery.md` — `@generacy-ai/workflow-engine` **minor** (new `phase:`/`completed:`/`failed:` label vocabulary + `CorePhase` widening → "new label vocabulary in `workflow-engine` → minor" per CLAUDE.md) + `@generacy-ai/config` **minor** (public `template-schema` phase keys widened) + `@generacy-ai/orchestrator` **patch** (internal plumbing, no new public exports) + `@generacy-ai/generacy` **patch** (`resume.ts` `KNOWN_PHASES`). Single file, all bumps.

## Next step

`/speckit:tasks` to generate the dependency-ordered task list.
