# Contract: phase vocabulary duplication sites

**Issue**: generacy-ai/generacy#1121

This is the authoritative enumeration of every site that encodes the `WorkflowPhase` vocabulary, and whether it must gain `review` + `remediate` (full-vocabulary) or is an intentional subset. The `phase-vocabulary-audit.test.ts` (FR-011) encodes this table; any drift fails the test.

## Full-vocabulary sites (MUST include `review` and `remediate`)

| # | Site | Kind | Enforced by |
|---|------|------|-------------|
| 0a | `orchestrator/src/worker/types.ts` `WorkflowPhase` | literal union | compiler (downstream `Record`) + audit |
| 0b | `orchestrator/src/worker/types.ts` `PHASE_TO_STAGE` | `Record<WorkflowPhase, StageType>` | compiler (exhaustive) |
| 1 | `orchestrator/src/worker/config.ts` `GateDefinitionSchema.phase` | `z.enum` + `satisfies readonly WorkflowPhase[]` | compiler (satisfies) + audit |
| 2 | `orchestrator/src/worker/config.ts` `PhaseTimeoutOverridesSchema` | strict-ish Zod object keys | audit |
| 3 | `orchestrator/src/worker/config.ts` agent-merge `phaseKeys` | `as const` array | audit |
| 4 | `orchestrator/src/worker/pause-context.ts` `WorkflowPhaseSchema` | `z.enum` | audit |
| 5 | `orchestrator/src/config/loader.ts` `overridablePhases` | `as const` array | audit |
| 6 | `config/src/template-schema.ts` `phases` | `.strict()` object keys | audit |
| 7 | `generacy/src/cli/commands/cockpit/resume.ts` `KNOWN_PHASES` | `readonly WorkflowPhase[]` | audit |
| 8 | `workflow-engine/src/types/github.ts` `CorePhase` | literal union | audit |
| 9 | `workflow-engine/src/actions/github/label-definitions.ts` `WORKFLOW_LABELS` | hand-written label map | audit (runtime probe) |

## Intentional-subset sites (MUST NOT be widened this issue — documented exclusions)

| Site | Reason |
|------|--------|
| `orchestrator/src/launcher/types.ts` `PhaseIntent['phase']` | launchable-CLI subset; already excludes `validate`; widening forces fake `/speckit:review` command (D-3) |
| `generacy-plugin-claude-code/src/launch/types.ts` `PhaseIntent['phase']` | same; `PHASE_TO_COMMAND` is `Record<PhaseIntent['phase'], string>` (D-3) |

## Sequence invariants

- `PHASE_SEQUENCE` = `['specify','clarify','plan','tasks','implement','review','validate']` — `review` after `implement`, before `validate`.
- `remediate` MUST NOT appear in `PHASE_SEQUENCE` or in any `WORKFLOW_PHASE_SEQUENCES` value.
- `WORKFLOW_PHASE_SEQUENCES['speckit-epic']` MUST equal `['specify','clarify','plan','tasks']` (byte-identical to pre-change).

## Label families (site #9)

For each of `review` and `remediate`, all four families exist (Q3=A):
`phase:<p>`, `completed:<p>`, `failed:<p>`, `failed:<p>-repeated`.
No `waiting-for:` labels are added for either phase.
