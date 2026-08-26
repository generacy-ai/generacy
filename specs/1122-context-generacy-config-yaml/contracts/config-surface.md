# Contract: `orchestrator.workflows` config surface + resolver

## YAML surface (`.generacy/config.yaml`)

```yaml
orchestrator:
  # existing repo-level tier (unchanged)
  validateCommand: "pnpm build"
  preValidateCommand: ""            # "" = skip install

  # existing agent block (unchanged, #1095) — independent map
  agents:
    workflows:
      speckit-bugfix:
        default: { provider: claude-code, model: sonnet }

  # NEW sibling map
  workflows:
    speckit-feature:
      validateCommand: "pnpm test && pnpm build"
      maxRemediations: 3
      review:
        profile: standard
        blockingSeverity: major       # explicit override of the 'critical' baseline
        failThenPass: false
    speckit-bugfix:
      preValidateCommand: ""          # skip install for bugfix jobs
      maxRemediations: 2
      review:
        profile: verification
        blockingSeverity: minor
```

## Zod schemas (`packages/config/src/template-schema.ts`)

```ts
export const WorkflowReviewSchema = z
  .object({
    profile: z.enum(['standard', 'verification']).optional(),
    blockingSeverity: z.enum(['critical', 'major', 'minor']).optional(),
    failThenPass: z.boolean().optional(),
  })
  .strict();
export type WorkflowReview = z.infer<typeof WorkflowReviewSchema>;

export const WorkflowOverrideSchema = z
  .object({
    validateCommand: z.string().optional(),
    preValidateCommand: z.string().optional(),
    maxRemediations: z.number().int().min(0).optional(),
    review: WorkflowReviewSchema.optional(),
  })
  .strict();
export type WorkflowOverride = z.infer<typeof WorkflowOverrideSchema>;

// added to OrchestratorSettingsSchema:
//   workflows: z.record(z.string(), WorkflowOverrideSchema).optional(),
```

New public exports from `packages/config/src/index.ts`: `WorkflowReviewSchema`,
`WorkflowOverrideSchema`, `WorkflowReview`, `WorkflowOverride`.

### Parse behavior

| Input | Result |
|-------|--------|
| No `orchestrator.workflows` key | `workflows` absent; identical worker config to today (SC-005). |
| `workflows.speckit-bugfix.maxRemediations: -1` | **throws** (`.int().min(0)`) (SC-004). |
| `workflows.speckit-bugfix.review.profile: aggressive` | **throws** (enum) (SC-004). |
| `workflows.speckit-bugfix.unknownKey: x` | **throws** (`.strict()`) (SC-004, US3 AC-2). |
| `workflows.speckit-bugfix.review.unknownKey: x` | **throws** (`.strict()`). |
| `workflows.speckit-bugfix.preValidateCommand: ""` | round-trips as `""` (US1 AC-3). |
| `workflows.speckit-bugfix.maxRemediations: 0` | round-trips as `0` (distinct from absent). |

## Resolver contract (`packages/orchestrator/src/worker/config.ts`)

```ts
export const DEFAULT_REVIEW: ResolvedWorkflowConfig['review']; // frozen baseline

export interface ResolvedWorkflowConfig {
  validateCommand: string;
  preValidateCommand: string;
  maxRemediations: number;
  review: {
    profile: 'standard' | 'verification';
    blockingSeverity: 'critical' | 'major' | 'minor';
    failThenPass: boolean;
  };
}

export function resolveWorkflowOverrides(
  config: WorkerConfig,
  settings: OrchestratorSettings | null | undefined,
  workflowName: string,
): ResolvedWorkflowConfig;
```

### Resolution table

| Resolved field | Walk (first non-nullish wins) |
|----------------|-------------------------------|
| `validateCommand` | `settings.workflows[w].validateCommand` → `settings.validateCommand` → `config.validateCommand` |
| `preValidateCommand` | `settings.workflows[w].preValidateCommand` → `settings.preValidateCommand` → `config.preValidateCommand` |
| `maxRemediations` | `settings.workflows[w].maxRemediations` → `defaultMaxRemediations(w)` |
| `review.profile` | `settings.workflows[w].review.profile` → `'standard'` |
| `review.blockingSeverity` | `settings.workflows[w].review.blockingSeverity` → `'critical'` |
| `review.failThenPass` | `settings.workflows[w].review.failThenPass` → `false` |

`defaultMaxRemediations('speckit-bugfix') === 2`; every other name (incl.
`speckit-feature` and unknown) `=== 3`.

### Invariants

- Pure function; does not mutate `config` or `settings`.
- Every returned field is fully resolved (never `undefined`).
- Nullish-coalescing walks preserve explicit `""`, `0`, `false`.
- `settings == null` or missing `workflows[w]` → validate/prevalidate equal cluster
  `config` values; `maxRemediations`/`review` equal built-in defaults (SC-001).
- Independent of `orchestrator.agents` — reads neither `settings.agents` nor `config.agents`.
