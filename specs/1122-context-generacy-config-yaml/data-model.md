# Data Model: Per-workflow orchestrator overrides

All types live in `@generacy-ai/config` (schemas) and `@generacy-ai/orchestrator`
(resolver return type). No persistence, no new I/O — this is config surface only.

## Entities

### `WorkflowReview` (new — `template-schema.ts`)

Per-workflow review-strictness override. Every field optional; each resolves independently
over the precedence chain.

| Field | Type | Notes |
|-------|------|-------|
| `profile` | `'standard' \| 'verification'` (opt) | Closed enum. |
| `blockingSeverity` | `'critical' \| 'major' \| 'minor'` (opt) | Closed enum. |
| `failThenPass` | `boolean` (opt) | Opt-in behavior. |

Zod: `.strict()` — unknown keys throw (FR-003, FR-009).

### `WorkflowOverride` (new — `template-schema.ts`)

Value type of the `orchestrator.workflows` map.

| Field | Type | Notes |
|-------|------|-------|
| `validateCommand` | `string` (opt) | Tier-1 of the three-tier validate chain. |
| `preValidateCommand` | `string` (opt) | `""` = skip install; preserved through resolve. |
| `maxRemediations` | `number` int ≥ 0 (opt) | `z.number().int().min(0)`. Explicit `0` legal and distinct from absent. |
| `review` | `WorkflowReview` (opt) | Nested strict object. |

Zod: `.strict()` (FR-001, FR-009).

### `OrchestratorSettings` (extended — `template-schema.ts`)

Adds one field to the existing schema:

| Field | Type | Notes |
|-------|------|-------|
| `workflows` | `Record<string, WorkflowOverride>` (opt) | `z.record(z.string(), WorkflowOverrideSchema)`. Open key space for extensible workflow names (FR-001, FR-008). Sibling to — never merged with — `agents.workflows`. |

Existing fields (`labelMonitor`, `webhookSetup`, `smeeChannelUrl`, `validateCommand`,
`preValidateCommand`, `agents`) unchanged.

### `ResolvedWorkflowConfig` (new — `worker/config.ts`)

Return type of `resolveWorkflowOverrides`. All fields fully resolved (no `undefined`).

| Field | Type | Source when unconfigured |
|-------|------|--------------------------|
| `validateCommand` | `string` | cluster `WorkerConfig.validateCommand` |
| `preValidateCommand` | `string` | cluster `WorkerConfig.preValidateCommand` |
| `maxRemediations` | `number` | `defaultMaxRemediations(workflowName)` (bugfix 2, else 3) |
| `review.profile` | `'standard' \| 'verification'` | `'standard'` |
| `review.blockingSeverity` | `'critical' \| 'major' \| 'minor'` | `'critical'` |
| `review.failThenPass` | `boolean` | `false` |

## Validation rules

- `maxRemediations`: integer ≥ 0 (schema); default applied at resolve time, not schema
  (FR-002, Decision 3).
- `review.profile` / `review.blockingSeverity`: closed Zod enums; any other string throws
  at parse (SC-004).
- All new object schemas `.strict()`: unknown keys throw (FR-009, US3 AC-2, SC-004).
- `preValidateCommand: ""` is a valid, meaningful value (skip install) — never coerced away.

## Relationships & precedence

```
orchestrator:
  validateCommand:      <repo-level, tier 2 for validate/prevalidate>
  preValidateCommand:   <repo-level, tier 2 for validate/prevalidate>
  agents:               <untouched — #1095>
    workflows:
      speckit-bugfix: { default, phases }        # agent selectors
  workflows:                                       # NEW sibling map
    speckit-bugfix:
      validateCommand:    <tier 1>
      preValidateCommand: <tier 1>
      maxRemediations:    <tier 1, no repo tier>
      review:
        profile:          <tier 1, no repo tier>
        blockingSeverity: <tier 1, no repo tier>
        failThenPass:     <tier 1, no repo tier>
```

Precedence per resolved field (independent walks):

- `validateCommand` / `preValidateCommand`: `workflows[w].X` → `orchestrator.X` →
  `WorkerConfig.X` (three tiers).
- `maxRemediations`: `workflows[w].maxRemediations` → `defaultMaxRemediations(w)` (two tiers).
- `review.<sub>`: `workflows[w].review.<sub>` → `DEFAULT_REVIEW.<sub>` (two tiers each).

`orchestrator.workflows` and `orchestrator.agents.workflows` are independent maps over the
same key space; neither reads the other.
