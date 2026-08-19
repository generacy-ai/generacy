# Implementation Plan: Per-workflow orchestrator overrides in `.generacy/config.yaml`

**Feature**: Add a `workflows` map to `OrchestratorSettingsSchema` so a target repo can vary `validateCommand`, `preValidateCommand`, `maxRemediations`, and a `review` block per workflow (e.g. `speckit-feature` vs `speckit-bugfix`), with precedence workflow-level > repo-level > cluster default.
**Branch**: `1122-context-generacy-config-yaml`
**Status**: Complete

**Issue**: generacy-ai/generacy#1122 | **Epic**: generacy-ai/generacy#1120 (engine-native review & remediate phases)

## Summary

Extend the config *surface* only. Today `.generacy/config.yaml`'s `orchestrator` block
lets a repo override two values repo-wide: `validateCommand` and `preValidateCommand`
(`packages/config/src/template-schema.ts:88,94`), merged by `applyRepoValidateOverrides`
(`packages/orchestrator/src/worker/config.ts:126`). This feature adds a sibling
`orchestrator.workflows.<name>` map holding `{ validateCommand, preValidateCommand,
maxRemediations, review }` and a resolver that walks the precedence chain per field.

The change is deliberately narrow (per clarifications Q1–Q4):

- **Q1 → A**: new sibling map `orchestrator.workflows.<name>`, kept separate from the
  already-shipped agent-specific `orchestrator.agents.workflows.<name>` (#1095). Both key
  on the same workflow-name space and compose without conflict.
- **Q2 → A**: `review`/`maxRemediations` have **no repo-level tier** — they resolve
  workflow-level > built-in default (two tiers). Only `validateCommand`/`preValidateCommand`
  keep the three-tier chain (workflow > repo > cluster).
- **Q3 → A**: built-in defaults — `review` = `{ profile: 'standard', blockingSeverity:
  'critical', failThenPass: false }`; `maxRemediations` = `speckit-feature` → 3,
  `speckit-bugfix` → 2, any other workflow name → 3. Defaults live in resolve logic (not
  schema `.default()`) so an absent key stays distinguishable from an explicit `0`/value.
- **Q4 → A**: ship the resolver function only. Do **not** add `maxRemediations`/`review`
  to `WorkerContext` yet — the consuming review/remediate phases are out of scope (epic
  #1120), and wiring them now would create dead fields no code reads.

## Technical Context

- **Language / runtime**: TypeScript, ESM, Node ≥ 22. Monorepo (`pnpm`).
- **Validation**: `zod` (already a direct dep of both touched packages).
- **Packages touched**:
  - `@generacy-ai/config` — schema extension + new exported types (public surface).
  - `@generacy-ai/orchestrator` — new resolver in `worker/config.ts` (internal surface).
- **No new dependencies.** No new files in the config package; one new test file per package.
- **Loader (FR-005)**: no change. `tryLoadOrchestratorSettings`
  (`packages/config/src/loader.ts:47`) already calls `OrchestratorSettingsSchema.parse(...)`;
  the extended schema flows through the existing parse path automatically.

## Design

### 1. Schema extension — `packages/config/src/template-schema.ts`

Add two schemas above `OrchestratorSettingsSchema`:

- `WorkflowReviewSchema` — `.strict()` object of `{ profile?, blockingSeverity?, failThenPass? }`
  with closed enums (`profile`: `standard | verification`; `blockingSeverity`:
  `critical | major | minor`; `failThenPass`: boolean). All optional; each resolves
  independently (FR-003, FR-010).
- `WorkflowOverrideSchema` — `.strict()` object of `{ validateCommand?: string,
  preValidateCommand?: string, maxRemediations?: z.number().int().min(0),
  review?: WorkflowReviewSchema }` (FR-001, FR-002, FR-003).

Add one field to `OrchestratorSettingsSchema`:

```ts
workflows: z.record(z.string(), WorkflowOverrideSchema).optional(),
```

`z.record(z.string(), …)` keeps the map open to future workflow names (FR-001, FR-008);
the value schema is `.strict()` so unknown keys fail loudly (FR-009, SC-004). Export
`WorkflowReviewSchema`, `WorkflowOverrideSchema` and the inferred `WorkflowReview`,
`WorkflowOverride` types from `packages/config/src/index.ts`.

`OrchestratorSettingsSchema` itself stays a plain `z.object` (matching today — it is not
currently `.strict()`), so this change does not tighten the top-level object beyond the
existing behavior. The **new** value schemas are `.strict()`, satisfying FR-009 for the
workflow sub-tree that this feature owns.

### 2. Resolver — `packages/orchestrator/src/worker/config.ts`

Add built-in constants and a resolver, siblings to `resolveAgentForPhase` /
`applyRepoValidateOverrides`:

```ts
export const DEFAULT_REVIEW = {
  profile: 'standard',
  blockingSeverity: 'critical',
  failThenPass: false,
} as const;

function defaultMaxRemediations(workflowName: string): number {
  return workflowName === 'speckit-bugfix' ? 2 : 3; // feature + all others → 3
}

export interface ResolvedWorkflowConfig {
  validateCommand: string;
  preValidateCommand: string;
  maxRemediations: number;
  review: { profile: 'standard' | 'verification';
            blockingSeverity: 'critical' | 'major' | 'minor';
            failThenPass: boolean };
}

export function resolveWorkflowOverrides(
  config: WorkerConfig,
  settings: OrchestratorSettings | null | undefined,
  workflowName: string,
): ResolvedWorkflowConfig { … }
```

Resolution (each field independent, FR-004):

| Field | Tier 1 (workflow) | Tier 2 (repo) | Tier 3 (cluster) |
|-------|-------------------|---------------|------------------|
| `validateCommand` | `settings.workflows[w].validateCommand` | `settings.validateCommand` | `config.validateCommand` |
| `preValidateCommand` | `settings.workflows[w].preValidateCommand` | `settings.preValidateCommand` | `config.preValidateCommand` |
| `maxRemediations` | `settings.workflows[w].maxRemediations` | — (no repo tier) | `defaultMaxRemediations(w)` |
| `review.profile` | `settings.workflows[w].review.profile` | — | `DEFAULT_REVIEW.profile` |
| `review.blockingSeverity` | `…review.blockingSeverity` | — | `DEFAULT_REVIEW.blockingSeverity` |
| `review.failThenPass` | `…review.failThenPass` | — | `DEFAULT_REVIEW.failThenPass` |

**`??` is correct for every field** and preserves the "empty string / `0` / `false` are
explicit values" invariant, because none of `""`, `0`, `false` are nullish:
- `preValidateCommand: ""` at workflow level survives (`"" ?? x === ""`) — matches the
  repo-level "skip install" semantics today (FR-004, US1 AC-3, SC-003).
- `maxRemediations: 0` at workflow level survives (`0 ?? 3 === 0`) — an explicit zero is
  distinguishable from absent (FR-002).
- `failThenPass: false` at workflow level survives (`false ?? true === false`).

The resolver takes the **raw** cluster `WorkerConfig` (tier 3 for validate commands) plus
the **raw** `OrchestratorSettings` (tiers 1 + 2), so it is fully self-contained and testable
in isolation without pre-merging via `applyRepoValidateOverrides` (SC-001..SC-005). It does
not mutate either input.

### 3. Plumb-through (FR-007 / FR-011)

Per Q4 → A, this feature ships the resolver **only**. `WorkerContext` is **not** extended;
`claude-cli-worker.ts` is **not** changed to call `resolveWorkflowOverrides`. The consuming
review/remediate phase (epic #1120) will import and call it, mirroring how
`resolveAgentForPhase` is consumed at `phase-loop.ts:528`, `pr-feedback-handler.ts:861`,
etc. The resolver is exercised by its unit tests, so it is not dead code. This avoids adding
`maxRemediations`/`review` fields to `WorkerContext` that no phase reads yet.

## Project Structure

```
packages/config/src/
  template-schema.ts         # + WorkflowReviewSchema, WorkflowOverrideSchema, workflows field
  index.ts                   # + export new schemas/types
  __tests__/
    template-schema.test.ts  # + parse/validation cases (SC-004, empty-string preserve)

packages/orchestrator/src/worker/
  config.ts                  # + DEFAULT_REVIEW, defaultMaxRemediations,
                             #   ResolvedWorkflowConfig, resolveWorkflowOverrides
  __tests__/
    resolve-workflow-overrides.test.ts  # NEW — SC-001..SC-005

.changeset/
  1122-per-workflow-orchestrator-overrides.md  # NEW
```

## Testing Strategy

- **Config schema** (`template-schema.test.ts`): valid `workflows` block parses; a
  `workflows` block with `maxRemediations: -1` throws; unknown `review.profile` throws;
  an unknown key inside `workflows.<name>` throws (`.strict()`); `preValidateCommand: ""`
  round-trips as `""` (SC-004, US1 AC-3, US3 AC-2).
- **Resolver** (`resolve-workflow-overrides.test.ts`, SC-001..SC-005):
  - SC-001: `settings = null` / no `workflows` → validate commands equal cluster defaults;
    `maxRemediations` = 3 for `speckit-feature`, 2 for `speckit-bugfix`; `review` =
    `DEFAULT_REVIEW`.
  - SC-002: repo-level `validateCommand` (no workflow entry) wins over cluster default;
    `maxRemediations`/`review` still fall to built-in default (no repo tier — Q2).
  - SC-003: workflow-level `validateCommand`/`maxRemediations`/`review.*` win over
    repo-level and cluster default; partial `review` (only `blockingSeverity` set) inherits
    `profile`/`failThenPass` from `DEFAULT_REVIEW`; empty-string workflow `preValidateCommand`
    preserved.
  - SC-004: covered by schema tests above.
  - SC-005: config with no `workflows` block yields validate/prevalidate identical to
    today's `applyRepoValidateOverrides` output (non-breaking; reference-equality fast paths
    in `applyRepoValidateOverrides` are untouched).

## Constitution Check

No `.specify/memory/constitution.md` present in the repo — no explicit governance gate.
The change follows the established config-surface pattern (`AgentsConfigSchema` /
`resolveAgentForPhase`, #1095): schema in `@generacy-ai/config`, resolver in
`worker/config.ts`, defaults in resolve logic, `.strict()` value schemas, no consumer
wiring ahead of the consuming phase.

## Changeset

`.changeset/1122-per-workflow-orchestrator-overrides.md`:
- `@generacy-ai/config` — **minor** (new user-facing `orchestrator.workflows` config
  vocabulary + new public schema/type exports).
- `@generacy-ai/orchestrator` — **patch** (new internal resolver; no new public exports,
  no behavior change to existing paths).

Single changeset file, both bumps. Test-only additions do not by themselves trip the gate,
but `template-schema.ts` and `config.ts` are non-test `src/` changes, so the changeset is
required.

## Out of Scope

- The review/remediate *phases* themselves (rest of epic #1120).
- Cluster-level defaults for `maxRemediations`/`review` beyond the hardcoded per-workflow
  constants.
- Any change to `orchestrator.agents` behavior.
- `WorkerContext` wiring / any `claude-cli-worker.ts` plumb-through (lands with the
  consuming phase, per Q4).
