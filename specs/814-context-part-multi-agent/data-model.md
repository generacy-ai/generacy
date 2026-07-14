# Data Model: Config Surface + Per-Phase Model Threading

Types organized by package. Additions marked NEW / MODIFIED.

## 1. Target-repo config schema (`packages/config/src/template-schema.ts`, MODIFIED)

Zod schemas added above the existing `OrchestratorSettingsSchema`; `OrchestratorSettingsSchema` grows one field.

```ts
export const AgentEntrySchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

export const WorkflowAgentEntriesSchema = z.object({
  default: AgentEntrySchema.optional(),
  phases: z.object({
    specify: AgentEntrySchema.optional(),
    clarify: AgentEntrySchema.optional(),
    plan: AgentEntrySchema.optional(),
    tasks: AgentEntrySchema.optional(),
    implement: AgentEntrySchema.optional(),
    validate: AgentEntrySchema.optional(),
  }).optional(),
});
export type WorkflowAgentEntries = z.infer<typeof WorkflowAgentEntriesSchema>;

export const AgentsConfigSchema = z.object({
  default: AgentEntrySchema.optional(),
  workflows: z.record(z.string(), WorkflowAgentEntriesSchema).optional(),
});
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

export const OrchestratorSettingsSchema = z.object({
  labelMonitor: z.boolean().optional(),
  webhookSetup: z.boolean().optional(),
  smeeChannelUrl: z.string().url().optional(),
  validateCommand: z.string().optional(),
  preValidateCommand: z.string().optional(),
  agents: AgentsConfigSchema.optional(),         // NEW
});
```

**Validation rules**:
- Both `provider` and `model` are optional at every tier (Q3→A independent resolution).
- `provider` and `model` must be non-empty strings when present (Q4→A opaque pass-through, no format check beyond non-empty).
- `phases` keys are enumerated per-field — Zod rejects unknown keys (`implment`, `pr-feedback`, etc.) at parse time (Q5→A closed set).
- `workflows` keys are `z.record(z.string())` — workflow names are extensible (`speckit-feature`, custom workflows in future).

## 2. CLI-facing schema mirror (`packages/generacy/src/config/schema.ts`, MODIFIED)

Same shapes as §1, imported (not redefined) to keep the two packages structurally identical:

```ts
// Preferred: re-export from @generacy-ai/config where possible
export { AgentEntrySchema, WorkflowAgentEntriesSchema, AgentsConfigSchema } from '@generacy-ai/config';
export type { AgentEntry, WorkflowAgentEntries, AgentsConfig } from '@generacy-ai/config';

// Extend the existing OrchestratorSettingsSchema mirror
export const OrchestratorSettingsSchema = z.object({
  pollIntervalMs: z.number().int().min(5000).optional(),
  workerCount: z.number().int().min(1).max(20).optional(),
  agents: AgentsConfigSchema.optional(),         // NEW
});
```

**Note**: The CLI-facing `OrchestratorSettingsSchema` has different fields (`pollIntervalMs`, `workerCount`) than the target-repo one (`validateCommand`, `preValidateCommand`, `labelMonitor`). This is pre-existing divergence — the CLI schema validates the operator-facing shape, the target-repo schema validates the repo-embedded shape. `agents` is added to both since it's meaningful in both contexts.

## 3. Worker config schema (`packages/orchestrator/src/worker/config.ts`, MODIFIED)

`WorkerConfigSchema` gets `agents` (the same `AgentsConfigSchema`) plus a `defaultsAgent` string field carrying the `defaults.agent` value from `.generacy/config.yaml` (repo-level provider default — provider-only, not an `AgentEntry`).

```ts
import { AgentsConfigSchema } from '@generacy-ai/config';

export const WorkerConfigSchema = z.object({
  // ... existing fields ...
  agents: AgentsConfigSchema.optional(),                        // NEW
  defaultsAgent: z.string().min(1).optional(),                  // NEW (from .generacy/config.yaml `defaults.agent`)
});
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;
```

**Validation rules**: Same as §1 for `agents`. `defaultsAgent` is a bare optional string — no kebab-case check at the worker layer (the CLI-facing schema at `packages/generacy/src/config/schema.ts:81-86` already enforces kebab-case at load time).

## 4. Cluster-default env plumbing (`packages/orchestrator/src/config/loader.ts`, MODIFIED)

New env-var pair (both independent per Q3→A):

| Env var | Writes to | Notes |
|---|---|---|
| `WORKER_AGENT_PROVIDER` | `config.worker.agents.default.provider` | Also accepted with `ORCHESTRATOR_` prefix like other worker env vars. |
| `WORKER_AGENT_MODEL` | `config.worker.agents.default.model` | Also accepted with `ORCHESTRATOR_` prefix. |

Setting only one is legal — the other resolves from higher tiers via the precedence chain.

Repo `defaults.agent` (from `.generacy/config.yaml`) is loaded separately via a new `tryLoadDefaultsAgent(configPath)` helper (sibling of the existing `tryLoadDefaultsRole` at loader.ts:249) and written to `config.worker.defaultsAgent`.

## 5. Merge helper (`packages/orchestrator/src/worker/config.ts`, NEW)

Sibling of `applyRepoValidateOverrides`. Pure function, order-independent with the validate-command merge, safe to compose either way.

```ts
export function applyRepoAgentOverrides(
  config: WorkerConfig,
  settings: OrchestratorSettings | null | undefined,
): WorkerConfig {
  if (settings == null || settings.agents === undefined) {
    return config;
  }
  // Deep merge of AgentsConfig — target repo's block overlays cluster-default
  // agents block. Provider/model on nested entries merge tier-by-tier.
  const merged: AgentsConfig = mergeAgentsConfig(config.agents, settings.agents);
  return { ...config, agents: merged };
}
```

**Merge semantics**:
- `agents.default`: target-repo `{provider,model}` fields overlay cluster-default `{provider,model}` fields, field-by-field. If target sets only `model`, cluster's `provider` survives.
- `agents.workflows.<name>.default`: same field-by-field merge.
- `agents.workflows.<name>.phases.<phase>`: same field-by-field merge.
- Workflow names not present in cluster default are pass-through from target.

## 6. Resolver signature (`packages/orchestrator/src/worker/config.ts`, NEW)

```ts
export function resolveAgentForPhase(
  config: WorkerConfig,
  workflowName: string,
  phase: WorkflowPhase,
): { provider: string; model?: string };
```

**Precedence** (Q3→A independent, walked separately for `provider` and `model`):

| Tier | Source | Applies to |
|---|---|---|
| 1 | `config.agents.workflows.<workflowName>.phases.<phase>` | both |
| 2 | `config.agents.workflows.<workflowName>.default` | both |
| 3 | `config.agents.default` | both |
| 4 | `config.defaultsAgent` (repo `defaults.agent`) | **provider only** |
| 5 | Cluster env (folded into tier 3 by loader) | (subsumed) |
| 6 | Built-in `'claude-code'` | **provider only** |

**Return contract**:
- `provider`: never `undefined` (tier 6 backstop guarantees a value).
- `model`: `undefined` when no tier 1-3 entry sets it. No built-in model default.

## 7. Intent + LaunchRequest field usage (already present from #813)

No new fields on these types — #813 already added them. `PhaseIntent.model?: string`, `PrFeedbackIntent.model?: string`, `LaunchRequest.provider?: string`. This issue lands the wiring that actually sets them.

## 8. `CliSpawnOptions` (`packages/orchestrator/src/worker/types.ts`, MODIFIED)

```ts
export interface CliSpawnOptions {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  resumeSessionId?: string;
  siblingWorkdirs?: Record<string, string>;
  /** NEW — resolved agent provider; threaded into LaunchRequest.provider. */
  provider?: string;
  /** NEW — resolved agent model; threaded into PhaseIntent.model / PrFeedbackIntent.model. */
  model?: string;
  /**
   * NEW — model from the previous phase, if any. Used by CliSpawner (or the
   * phase-loop caller) to emit the `agent.model.transition prev=<m> next=<m>`
   * log line on same-provider model change (Q2→C). Only meaningful when
   * `resumeSessionId` is also set (session preserved across the transition).
   */
  previousModel?: string;
}
```

## 9. Phase-loop closure state (`packages/orchestrator/src/worker/phase-loop.ts`, MODIFIED)

Additions to `executeLoop`'s local scope:

```ts
let currentSessionId: string | undefined = /* existing */;
let currentProvider: string | undefined;  // NEW — tracks provider of the currently-held session
let currentModel: string | undefined;     // NEW — tracks last model, for `previousModel` on next spawn
```

Per-phase transition logic (before spawn):

```ts
const { provider: nextProvider, model: nextModel } = resolveAgentForPhase(config, workflowName, cliPhase);
if (currentProvider !== undefined && currentProvider !== nextProvider) {
  currentSessionId = undefined;   // provider switch — drop session (FR-011)
}
const previousModel = currentProvider === nextProvider ? currentModel : undefined;
// spawn with { provider: nextProvider, model: nextModel, previousModel, resumeSessionId: currentSessionId }
currentProvider = nextProvider;
currentModel = nextModel;
```

`workflowName` is available on `context.item.workflowName`. `cliPhase` is the loop's current phase (Exclude<WorkflowPhase, 'validate'>).

## 10. `agent.model.transition` log line

Emitted from `phase-loop.ts` right after the resolver call, when:
- `currentProvider === nextProvider` (same provider, or first phase — but no prev model to compare), AND
- `currentModel !== undefined && nextModel !== undefined && currentModel !== nextModel`

Shape: `logger.info({ provider: nextProvider, prevModel: currentModel, nextModel }, 'agent.model.transition')`.

## 11. Relationships

```
target-repo .generacy/config.yaml
  └── orchestrator.agents (OrchestratorSettings.agents)  ─┐
                                                          │
cluster env (WORKER_AGENT_PROVIDER/MODEL)                 │
  └── loader writes → config.worker.agents.default  ──────┼──▶ mergeAgentsConfig
                                                          │
`defaults.agent` (target-repo config.yaml)                │
  └── loader writes → config.worker.defaultsAgent  ───────┘
                                                                  │
                                                                  ▼
                                                          WorkerConfig (merged)
                                                                  │
                                                                  ▼
                                                  resolveAgentForPhase(config, workflowName, phase)
                                                                  │
                                                                  ▼
                                                          { provider, model? }
                                                                  │
                                                                  ▼
                                                          CliSpawnOptions
                                                                  │
                                                                  ▼
                                                          LaunchRequest.provider
                                                          PhaseIntent.model / PrFeedbackIntent.model
                                                                  │
                                                                  ▼
                                                  ClaudeCodeLaunchPlugin.buildPhaseLaunch (or buildPrFeedbackLaunch)
                                                                  │
                                                                  ▼
                                                          argv includes ['--model', model]
```

## 12. Not modeled here (out of scope)

- Custom-workflow phase names (`workflows.<custom>.phases.<custom-phase>`) — Q5→A closed set.
- Provider-plugin model allowlists — Q4→A opaque pass-through.
- Dedicated `agents.prFeedback` slot — Q1→B binds pr-feedback to `implement`; a separate slot can layer on later.
- Session drop on same-provider model change — Q2→C preserves session, log line only.
- Config-schema surface in `packages/orchestrator-types` — subset-by-design (#813 D-8).
