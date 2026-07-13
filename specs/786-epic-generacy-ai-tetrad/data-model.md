# Data Model: @generacy-ai/cockpit

## Curated state

### `CockpitState` (string-literal union)

```ts
export const COCKPIT_STATES = ['pending', 'active', 'waiting', 'error', 'terminal', 'unknown'] as const;
export type CockpitState = (typeof COCKPIT_STATES)[number];
```

**Tier rank (lower = higher precedence)**:

| State      | Rank | Meaning                                                |
|------------|------|--------------------------------------------------------|
| `terminal` | 0    | Closed/done; epic-approval merged; children complete.  |
| `error`    | 1    | Any `failed:*` or `agent:error`.                       |
| `waiting`  | 2    | Any `waiting-for:*` or `needs:*`.                      |
| `active`   | 3    | `phase:*`, `agent:in-progress`, `agent:dispatched`.    |
| `pending`  | 4    | Type/process/workflow identity labels, `agent:paused`. |
| `unknown`  | 5    | Label not in `WORKFLOW_LABELS`.                        |

### `ClassifyResult`

```ts
export interface ClassifyResult {
  state: CockpitState;       // curated tier of the winning label
  sourceLabel: string;       // exact label name that won (e.g. 'waiting-for:clarification')
}
```

**Invariants**:

- `state === 'unknown'` ⇒ `sourceLabel === ''` (no winning label).
- For any non-empty input where at least one label is in `WORKFLOW_LABELS`, `state !== 'unknown'` and `sourceLabel` is one of those labels.
- The winner is the label with the lowest tier rank; ties are broken by `WAITING_PIPELINE_ORDER` (when tier is `waiting`) or `WORKFLOW_LABELS` index (otherwise).

## Config schema

### `CockpitConfig`

```ts
export const CockpitConfigSchema = z.object({
  owner: z.string().min(1).optional(),
  repos: z.array(z.string().regex(/^[^/]+\/[^/]+$/, 'must be owner/repo')).default([]),
  orchestrator: z
    .object({
      baseUrl: z.string().url().optional(),
      token: z.string().min(1).optional(),
    })
    .optional()
    .default({}),
});

export type CockpitConfig = z.infer<typeof CockpitConfigSchema>;
```

**Defaults applied by `loadCockpitConfig()`** (post-schema-parse):

- `owner`: explicit > `gh auth status` login > `undefined` (commands needing owner error at use-time).
- `repos`: `cockpit.repos` > parsed `MONITORED_REPOS` env > `[]` (warn-logged when both unset).
- `orchestrator.token`: explicit > `ORCHESTRATOR_API_TOKEN` env > `undefined` (degraded mode).
- `orchestrator.baseUrl`: explicit > `ORCHESTRATOR_URL` env > `http://127.0.0.1:3100` (matches monorepo convention in `packages/control-plane/bin/control-plane.ts`).

**Loader return shape**:

```ts
export interface LoadedCockpitConfig {
  config: CockpitConfig;
  source: 'cockpit-block' | 'monitored-repos-env' | 'defaults';
  warnings: string[];   // populated on absent-config / empty-repos paths
}
```

## Epic manifest schema

### `EpicManifest`

```ts
export const EpicEntrySchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/),    // 'owner/repo'
  issue: z.number().int().positive(),
  slug: z.string().min(1),
  plan: z.string().min(1),                      // path to the plan doc, e.g. 'docs/epic-cockpit-plan.md'
});

export const PhaseEntrySchema = z.object({
  name: z.string().min(1),
  tier: z.string().min(1).optional(),
  repos: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).default([]),
  issues: z.array(z.string().regex(/^[^/]+\/[^/]+#\d+$/, 'must be owner/repo#n')).default([]),
});

export const EpicManifestSchema = z.object({
  epic: EpicEntrySchema,
  autonomy: z.record(z.unknown()).default({}),    // reserved; empty for v1
  phases: z.array(PhaseEntrySchema).default([]),
});

export type EpicManifest = z.infer<typeof EpicManifestSchema>;
```

**On-disk path**: `.generacy/epics/<slug>.yaml` in the epic-parent's repo (see clarification Q3).

**Invariants**:

- `epic.repo` matches the repo where the manifest lives.
- All `phases[*].issues` entries are normalized to `owner/repo#n` strings.
- `slug` matches the YAML filename's basename (e.g. `epic-cockpit.yaml` ⇒ `slug: 'epic-cockpit'`). Not enforced by schema (filesystem invariant), but `appendChildIssue` validates on read.

## `gh` wrapper data shapes

### `Issue` (returned by `listIssues`)

```ts
export interface Issue {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];               // label names only
  url: string;
  body: string;                   // empty string if gh returns null
  author?: { login: string };
}
```

### `CheckRunSummary` (returned by `getPullRequestCheckRuns`)

```ts
export interface CheckRunSummary {
  name: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
  conclusion?: string;
  url?: string;
}
```

Both shapes are derived from `gh ... --json …` output; the wrapper validates with Zod and throws a descriptive error on shape mismatch.

## Orchestrator client shapes

### `OrchestratorClient` interface

```ts
export interface OrchestratorClient {
  isAvailable(): boolean;
  health(): Promise<HealthResult>;
  getJobs(): Promise<JobsResult>;
  getWorkers(): Promise<WorkersResult>;
}
```

### Result envelopes

All result methods return discriminated unions. Stubs never throw.

```ts
export type HealthResult =
  | { available: false; reason: 'no-token' | 'cloud-unreachable' | 'http-error'; statusCode?: number }
  | { available: true; status: 'ok' | 'degraded'; data: Record<string, unknown> };

export type JobsResult =
  | { available: false; reason: 'no-token' | 'cloud-unreachable' | 'http-error'; statusCode?: number }
  | { available: true; jobs: JobSummary[] };

export type WorkersResult =
  | { available: false; reason: 'no-token' | 'cloud-unreachable' | 'http-error'; statusCode?: number }
  | { available: true; workers: WorkerSummary[] };

export interface JobSummary {
  id: string;
  status: string;                  // pass-through from orchestrator
  workflowId?: string;
}

export interface WorkerSummary {
  id: string;
  status: string;                  // pass-through from orchestrator
  currentJobId?: string;
}
```

**Invariants**:

- `isAvailable()` returns `false` ⇔ all methods will resolve to `{ available: false, reason: 'no-token' }`. Pure synchronous predicate; never throws.
- Stub is constructed when `config.token` is `undefined` or empty after env-var resolution.
- Live client maps HTTP error responses to `{ available: false, reason: 'http-error', statusCode }` rather than throwing. Network errors map to `{ available: false, reason: 'cloud-unreachable' }`.

## Relationships

```text
@generacy-ai/workflow-engine        @generacy-ai/config
    │                                   │
    │ WORKFLOW_LABELS                   │ findWorkspaceConfigPath
    │ LabelDefinition                   │
    ▼                                   ▼
                @generacy-ai/cockpit
                ├── state/        (uses WORKFLOW_LABELS)
                ├── config/       (uses workspace loader)
                ├── manifest/     (owns EpicManifestSchema)
                ├── gh/           (depends on injected CommandRunner)
                └── orchestrator/ (depends on injected HttpClient)
                       │
                       ▼
              Public exports (src/index.ts)
                       │
                       ▼
            Downstream cockpit UIs / CLIs
            (G0.x sibling issues — not built here)
```

No package depends back on `@generacy-ai/cockpit` in this PR; downstream consumers ship in later G0.x issues.

## Public API surface (exported from `src/index.ts`)

```ts
// State + classifier
export { COCKPIT_STATES, type CockpitState, type ClassifyResult } from './types.js';
export { classify } from './state/classifier.js';
export { TIER_RANK, WAITING_PIPELINE_ORDER } from './state/precedence.js';

// Config
export { CockpitConfigSchema, type CockpitConfig, type LoadedCockpitConfig } from './config/schema.js';
export { loadCockpitConfig } from './config/loader.js';

// Manifest
export {
  EpicManifestSchema,
  EpicEntrySchema,
  PhaseEntrySchema,
  type EpicManifest,
} from './manifest/schema.js';
export { readManifest, writeManifest, appendChildIssue } from './manifest/io.js';
export { resolveEpicIssues } from './manifest/scoping.js';

// gh wrapper
export { GhCliWrapper, type GhWrapper, type CommandRunner } from './gh/wrapper.js';
export type { Issue, CheckRunSummary } from './gh/wrapper.js';

// Orchestrator client
export {
  createOrchestratorClient,
  type OrchestratorClient,
  type HealthResult,
  type JobsResult,
  type WorkersResult,
  type JobSummary,
  type WorkerSummary,
} from './orchestrator/client.js';
```

Internal modules (e.g. `state/label-map.ts`, `gh/command-runner.ts`, `orchestrator/http.ts`, `orchestrator/stub.ts`) are not exported.
