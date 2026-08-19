# Tasks: Per-workflow orchestrator overrides in `.generacy/config.yaml`

**Input**: Design documents from `/specs/1122-context-generacy-config-yaml/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/config-surface.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Config Schema Extension (`@generacy-ai/config`)

- [ ] T001 [US1] [US2] [US3] In `packages/config/src/template-schema.ts`, add two new
      `.strict()` Zod schemas **above** `OrchestratorSettingsSchema`:
      - `WorkflowReviewSchema` = `{ profile?: z.enum(['standard','verification']),
        blockingSeverity?: z.enum(['critical','major','minor']), failThenPass?: z.boolean() }`
        (all optional). Export inferred type `WorkflowReview`.
      - `WorkflowOverrideSchema` = `{ validateCommand?: z.string(),
        preValidateCommand?: z.string(), maxRemediations?: z.number().int().min(0),
        review?: WorkflowReviewSchema }`. Export inferred type `WorkflowOverride`.
      Then add `workflows: z.record(z.string(), WorkflowOverrideSchema).optional()` as a new
      field on `OrchestratorSettingsSchema` (sibling to `agents`; do NOT touch `agents`).
      Leave `OrchestratorSettingsSchema` as a plain `z.object` (do not add `.strict()` — matches
      today). (FR-001, FR-002, FR-003, FR-008, FR-009)

- [ ] T002 [US1] [US2] In `packages/config/src/index.ts`, re-export the new public surface:
      `WorkflowReviewSchema`, `WorkflowOverrideSchema`, and the `WorkflowReview`,
      `WorkflowOverride` types. (FR-001; contracts/config-surface.md)

## Phase 2: Resolver (`@generacy-ai/orchestrator`)

- [ ] T003 [US1] [US2] [US3] In `packages/orchestrator/src/worker/config.ts`, add siblings to
      `applyRepoValidateOverrides` / `resolveAgentForPhase`:
      - `export const DEFAULT_REVIEW = { profile: 'standard', blockingSeverity: 'critical',
        failThenPass: false } as const;`
      - `function defaultMaxRemediations(workflowName: string): number` → returns `2` for
        `'speckit-bugfix'`, else `3`.
      - `export interface ResolvedWorkflowConfig` = `{ validateCommand, preValidateCommand,
        maxRemediations, review: { profile, blockingSeverity, failThenPass } }` (all fully
        resolved, never `undefined`).
      - `export function resolveWorkflowOverrides(config, settings, workflowName):
        ResolvedWorkflowConfig` — a pure function that does NOT mutate `config`/`settings`,
        walking each field independently with `??` (first non-nullish wins) per the resolution
        table below. Handle `settings == null`. **Do NOT** extend `WorkerContext` or touch
        `claude-cli-worker.ts` (FR-011 / Q4 — that wiring lands with the consuming phase).

      Resolution walks (independent per field, `??` preserves `""`/`0`/`false`):
      - `validateCommand`: `settings.workflows[w].validateCommand` → `settings.validateCommand` → `config.validateCommand`
      - `preValidateCommand`: `settings.workflows[w].preValidateCommand` → `settings.preValidateCommand` → `config.preValidateCommand`
      - `maxRemediations`: `settings.workflows[w].maxRemediations` → `defaultMaxRemediations(w)`
      - `review.profile`: `settings.workflows[w].review?.profile` → `DEFAULT_REVIEW.profile`
      - `review.blockingSeverity`: `settings.workflows[w].review?.blockingSeverity` → `DEFAULT_REVIEW.blockingSeverity`
      - `review.failThenPass`: `settings.workflows[w].review?.failThenPass` → `DEFAULT_REVIEW.failThenPass`
      (FR-004, FR-006, FR-010, FR-011)

## Phase 3: Tests

- [ ] T004 [P] [US1] [US2] [US3] Extend `packages/config/src/__tests__/template-schema.test.ts`
      with parse/validation cases:
      - Valid `workflows` block (feature + bugfix, with `review`) parses.
      - `workflows.<name>.maxRemediations: -1` throws (`.int().min(0)`) — SC-004.
      - `workflows.<name>.review.profile: aggressive` throws (enum) — SC-004.
      - Unknown key inside `workflows.<name>` throws (`.strict()`) — SC-004, US3 AC-2.
      - Unknown key inside `review` throws (`.strict()`).
      - `preValidateCommand: ""` round-trips as `""` — US1 AC-3.
      - `maxRemediations: 0` round-trips as `0` (distinct from absent) — FR-002.
      - Config with no `workflows` key still parses unchanged — US3 AC-1.

- [ ] T005 [P] [US1] [US2] [US3] Create `packages/orchestrator/src/worker/__tests__/resolve-workflow-overrides.test.ts`
      covering the resolver (SC-001..SC-005):
      - SC-001: `settings = null` / no `workflows` → validate commands equal cluster
        `config` defaults; `maxRemediations` = 3 for `speckit-feature`, 2 for `speckit-bugfix`;
        `review` deep-equals `DEFAULT_REVIEW`.
      - SC-002: repo-level `settings.validateCommand` (no workflow entry) wins over cluster
        default; `maxRemediations`/`review` still fall to built-in default (no repo tier — Q2).
      - SC-003: workflow-level `validateCommand`/`maxRemediations`/`review.*` win over repo-level
        and cluster default; partial `review` (only `blockingSeverity`) inherits
        `profile`/`failThenPass` from `DEFAULT_REVIEW`; workflow-level `preValidateCommand: ""`
        preserved; workflow-level `maxRemediations: 0` preserved.
      - SC-005: no `workflows` block yields validate/prevalidate identical to today (non-breaking);
        assert the resolver does not mutate its `config`/`settings` inputs.

## Phase 4: Changeset & Verification

- [ ] T006 [US1] [US2] [US3] Add `.changeset/1122-per-workflow-orchestrator-overrides.md` as a
      **newly added** file: `@generacy-ai/config` **minor** (new `orchestrator.workflows` config
      vocabulary + new public schema/type exports), `@generacy-ai/orchestrator` **patch** (new
      internal resolver, no public export/behavior change). Single file, both bumps. Required
      because `template-schema.ts` and `config.ts` are non-test `src/` changes.

- [ ] T007 [US3] Verification: run `pnpm --filter @generacy-ai/config --filter @generacy-ai/orchestrator build`,
      the two new/updated test files (`pnpm --filter @generacy-ai/config test` +
      `pnpm --filter @generacy-ai/orchestrator test -- resolve-workflow-overrides`), and lint.
      Confirm SC-001..SC-005 pass and no existing `applyRepoValidateOverrides` /
      `resolveAgentForPhase` test regressed.

## Dependencies & Execution Order

**Sequential chain**:
- T001 → T002 (index.ts re-exports symbols defined in template-schema.ts).
- T001, T002 → T003 (resolver imports `OrchestratorSettings`/`WorkflowOverride` types from
  `@generacy-ai/config`).
- T003 → T005 (resolver test imports `resolveWorkflowOverrides` / `DEFAULT_REVIEW`).
- T001 → T004 (schema test imports the extended `OrchestratorSettingsSchema`).
- T004, T005 → T006 → T007 (changeset + full verification last).

**Parallel opportunities**:
- T004 and T005 are `[P]` — different files in different packages, no shared state. Each only
  needs its own upstream impl task (T004 after T001; T005 after T003).

**No setup phase**: no new dependencies, no new package scaffolding (per plan Technical Context).

**Playbook coupling**: none — no `packages/claude-plugin-cockpit/commands/*.md` path is
referenced by spec.md, plan.md, or contracts, so no `playbook-verification.test.ts` re-pin task
is required.
