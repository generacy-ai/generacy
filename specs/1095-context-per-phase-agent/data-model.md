# Data Model: per-phase effort + fixer parity (#1095)

Every entity is additive — no existing shape is removed or renamed.

## Effort enum

**Location**: `packages/config/src/template-schema.ts` (new, co-located with `AgentEntry`).

```ts
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;
```

**Rationale**: Closed enum matching the installed Claude CLI vocabulary (v2.1.150). Fixed per Q2 answer A — stable across CLI upgrades, values the CLI doesn't recognize become validated no-ops via the plugin's `hasEffortMechanism()` (Decision 5).

**Validation rules**:
- Case-sensitive match on one of the five strings.
- No default; unset stays unset (FR-010 backward compat).
- Zod rejects unknown values (`super`, `MAX`, `xhigh1`) with a message naming the invalid value (SC-005).

---

## AgentEntry (extended)

**Location**: `packages/config/src/template-schema.ts:14-17` (existing schema, extended).

```ts
export const AgentEntrySchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: EffortSchema.optional(),                     // NEW
}).strict();                                            // NEW — Q4/D-2
export type AgentEntry = z.infer<typeof AgentEntrySchema>;
```

**Changes**:
- New optional `effort` field (FR-001).
- Adds `.strict()` — rejects unknown keys inside an entry (FR-011, SC-006).

**Merge semantics** (via `mergeAgentEntry` in `worker/config.ts:165-179` — extended to handle `effort`):
- Field-by-field, repo-over-cluster (FR-003).
- Setting only `effort` on the repo does NOT drop the cluster's `provider` or `model` (and vice versa).
- All three fields resolve independently.

---

## WorkflowAgentEntries (extended, strictened)

**Location**: `packages/config/src/template-schema.ts:25-37` (existing schema, strictened).

```ts
export const WorkflowAgentEntriesSchema = z.object({
  default: AgentEntrySchema.optional(),
  phases: z
    .object({
      specify: AgentEntrySchema.optional(),
      clarify: AgentEntrySchema.optional(),
      plan: AgentEntrySchema.optional(),
      tasks: AgentEntrySchema.optional(),
      implement: AgentEntrySchema.optional(),
      validate: AgentEntrySchema.optional(),
    })
    .strict()                                          // NEW — Q4/D-2
    .optional(),
}).strict();                                            // NEW — Q4/D-2
```

**Changes**: `.strict()` on both the outer object (rejects unknown keys under `workflows.<name>`) and the inner `phases` object (rejects unknown phase keys like `implment`). The inner `phases` was already an exact enumeration; the strict mode makes the rejection explicit and consistent with the outer level.

---

## AgentsConfig (extended, strictened)

**Location**: `packages/config/src/template-schema.ts:54-57` (existing schema, strictened).

```ts
export const AgentsConfigSchema = z.object({
  default: AgentEntrySchema.optional(),
  workflows: z.record(z.string(), WorkflowAgentEntriesSchema).optional(),
}).strict();                                            // NEW — Q4/D-2
```

**Changes**: `.strict()` at the top of the block (rejects unknown keys under `orchestrator.agents`, e.g. `defualt:` typo).

**Note**: `workflows` is a `z.record(z.string(), ...)` — arbitrary workflow names are legal by design (`speckit-feature`, `speckit-bugfix`, plus future workflows). Only the enclosing keys (`default`, `workflows`) are strictened at this level.

---

## resolveAgentForPhase return (extended)

**Location**: `packages/orchestrator/src/worker/config.ts:280-295` (existing helper, return type widened).

```ts
export function resolveAgentForPhase(
  config: WorkerConfig,
  workflowName: string,
  phase: WorkflowPhase,
): { provider: string; model?: string; effort?: Effort } {
  const workflowEntry = config.agents?.workflows?.[workflowName];
  const tiers: (AgentsConfig['default'] | undefined)[] = [
    workflowEntry?.phases?.[phase],
    workflowEntry?.default,
    config.agents?.default,
  ];
  const providerFromTiers = tiers.find((t) => t?.provider !== undefined)?.provider;
  const provider = providerFromTiers ?? config.defaultsAgent ?? DEFAULT_PROVIDER;
  const model = tiers.find((t) => t?.model !== undefined)?.model;
  const effort = tiers.find((t) => t?.effort !== undefined)?.effort;                 // NEW
  const out: { provider: string; model?: string; effort?: Effort } = { provider };
  if (model !== undefined) out.model = model;
  if (effort !== undefined) out.effort = effort;
  return out;
}
```

**Changes**: Effort walks the same 3-tier list as model (phase entry → workflow default → agents.default). No built-in default; unset stays unset.

**Precedence chain (unchanged, `effort` added as fourth independent field walk)**:
| Tier | provider | model | effort |
|------|----------|-------|--------|
| 1 | phase entry | phase entry | phase entry |
| 2 | workflow default | workflow default | workflow default |
| 3 | agents.default | agents.default | agents.default |
| 4 | `defaultsAgent` | — | — |
| 5 | `DEFAULT_PROVIDER='claude-code'` | — | — |

---

## CliSpawnOptions (extended)

**Location**: `packages/orchestrator/src/worker/types.ts:220-255` (existing, extended).

```ts
export interface CliSpawnOptions {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  resumeSessionId?: string;
  siblingWorkdirs?: Record<string, string>;
  provider?: string;
  model?: string;
  effort?: Effort;                                     // NEW
  previousModel?: string;
}
```

**Note**: `previousEffort` is deliberately NOT added — same-provider effort transitions do not require session-transition telemetry. Add later if the need materializes.

---

## PhaseIntent (extended)

**Location**: `packages/orchestrator/src/launcher/types.ts:31-41` (existing, extended).

```ts
export interface PhaseIntent {
  kind: 'phase';
  phase: 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement';
  prompt: string;
  sessionId?: string;
  model?: string;
  effort?: Effort;                                     // NEW
}
```

---

## PrFeedbackIntent (extended)

**Location**: `packages/orchestrator/src/launcher/types.ts:46-54` (existing, extended).

```ts
export interface PrFeedbackIntent {
  kind: 'pr-feedback';
  prNumber: number;
  prompt: string;
  model?: string;
  effort?: Effort;                                     // NEW
}
```

---

## ValidateFixIntent (extended)

**Location**: `packages/orchestrator/src/launcher/types.ts:61-69` (existing, extended).

```ts
export interface ValidateFixIntent {
  kind: 'validate-fix';
  prNumber: number;
  prompt: string;
  evidenceHash: string;
  provider?: string;                                   // NEW
  model?: string;                                      // NEW
  effort?: Effort;                                     // NEW
}
```

**Note**: `provider` is added on this intent for symmetry with the LaunchRequest routing story. In practice, `provider` is threaded via `LaunchRequest.provider` (not the intent), matching how `pr-feedback-handler.ts:879` does it today. The intent field is defensive breadcrumb for downstream observers; the plugin argv path reads only `model` + `effort` from the intent.

---

## MergeConflictIntent (extended)

**Location**: `packages/orchestrator/src/launcher/types.ts:75-81` (existing, extended).

```ts
export interface MergeConflictIntent {
  kind: 'merge-conflict';
  issueNumber: number;
  prompt: string;
  provider?: string;                                   // NEW
  model?: string;                                      // NEW
  effort?: Effort;                                     // NEW
}
```

**Same routing note as `ValidateFixIntent`**.

---

## ClaudeCodeLaunchPlugin (extended)

**Location**: `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` (existing, extended).

**Static capability**:
```ts
export class ClaudeCodeLaunchPlugin {
  readonly pluginId = 'claude-code';
  readonly provider = 'claude-code';
  readonly supportedKinds = ['phase', 'pr-feedback', 'validate-fix', 'merge-conflict', 'conversation-turn', 'invoke'] as const;

  /**
   * Whether the installed CLI supports a delivery mechanism for reasoning effort.
   * v2.1.150 exposes `--effort <level>`; flip this to `false` if a future release removes the flag.
   * Consulted by validate-time (packages/generacy) and spawn-time (orchestrator) warning surfaces per FR-010a.
   */
  static hasEffortMechanism(): boolean {
    return true;
  }
  // ...
}
```

**Builder extension** (identical shape in all four builders):
```ts
if (intent.model) {
  args.push('--model', intent.model);
}
if (intent.effort) {                                   // NEW
  args.push('--effort', intent.effort);
}
```

The `--effort` push is added in `buildPhaseLaunch`, `buildPrFeedbackLaunch`, `buildValidateFixLaunch`, `buildMergeConflictLaunch`. Not added in `buildInvokeLaunch` or `buildConversationTurnLaunch` — out of scope.

---

## Warning payload

**Location**: `packages/generacy/src/config/loader.ts` (new field on return type).

```ts
export interface LoadConfigResult {
  config: GeneracyConfig;
  warnings: string[];
}
```

**Warning strings**:

- **Validate-time (FR-010a-a)**: `orchestrator.agents.workflows.${name}.phases.${phase}.effort — set to '${value}' but provider '${provider}' has no CLI mechanism for effort in this release. The field will be dropped at spawn time.`
- **Spawn-time (FR-010a-b, orchestrator log)**: `agent.effort.dropped {workflow, phase, provider, effort, reason: 'no-cli-mechanism'}` — structured pino log at `warn` level.

Under CLI v2.1.150, `hasEffortMechanism()` returns `true` and neither warning surfaces.

---

## Entity Relationships

```
              GeneracyConfig
                    │
                    │  orchestrator.agents
                    ▼
              AgentsConfig ─────────────────┐
                    │                       │
                    │  default              │  workflows[name]
                    ▼                       ▼
              AgentEntry            WorkflowAgentEntries
              ┌─────────┐                   │
              │provider │                   │  default        phases[phase]
              │model    │                   ▼                 ▼
              │effort   │◄─────────── AgentEntry ─────► AgentEntry
              └─────────┘

resolveAgentForPhase(config, workflowName, phase) → { provider, model?, effort? }
                                                                │
                                                                ▼
                                                       CliSpawnOptions
                                                                │
                                                                ▼
              ┌────────────────────────────────────────────────────────┐
              ▼                     ▼                    ▼             ▼
        PhaseIntent         PrFeedbackIntent     ValidateFixIntent  MergeConflictIntent
                                                                     
              ▼                     ▼                    ▼             ▼
                          ClaudeCodeLaunchPlugin.buildLaunch(intent)
                                                                     
                                       ▼
                             LaunchSpec { command, args, env }
                                       │
                                       ▼
                             claude -p --model X --effort Y ...
```
