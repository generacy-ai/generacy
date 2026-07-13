# Contract: `resolveAgentForPhase`

**Location**: `packages/orchestrator/src/worker/config.ts`.
**Signature**:

```ts
export function resolveAgentForPhase(
  config: WorkerConfig,
  workflowName: string,
  phase: WorkflowPhase,
): { provider: string; model?: string };
```

## Behavior

Two **independent** walks (Q3→A) — one for `provider`, one for `model` — over the same tier list:

| # | Source (highest first) | Applies to |
|---|---|---|
| 1 | `config.agents?.workflows?.[workflowName]?.phases?.[phase]` | both |
| 2 | `config.agents?.workflows?.[workflowName]?.default` | both |
| 3 | `config.agents?.default` | both |
| 4 | `config.defaultsAgent` (from repo `defaults.agent`) | **provider only** |
| 5 | Built-in `'claude-code'` (module-level constant) | **provider only** |

For each walk, take the first tier where the field is set. If no tier sets `model`, return `undefined`.

The env tier (`WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL`) is not visible to the resolver — the loader folds it into tier 3 (`config.agents.default`) at config-load time.

## Return contract

- `provider`: always a non-empty string (tier 5 backstop guarantees a value).
- `model`: `string | undefined`. `undefined` when no tier 1–3 entry sets it (there is no built-in model default — the CLI plugin skips `--model` and Claude uses its own default model).

## Independence invariant

Provider and model resolve independently at every tier. Setting a phase-tier `provider` without `model` does NOT block a lower tier's `model` — and vice versa.

Concrete example:

```yaml
orchestrator:
  agents:
    default: { model: claude-sonnet-4-6 }             # tier 3 sets model
    workflows:
      speckit-feature:
        phases:
          implement: { provider: claude-code }         # tier 1 sets provider only
```

`resolveAgentForPhase(config, 'speckit-feature', 'implement')` returns `{ provider: 'claude-code', model: 'claude-sonnet-4-6' }`.

## Error surface

The resolver **never throws** — it always returns a valid `{ provider, model? }` triple. Unknown providers surface later at `AgentLauncher.launch()` as `UnknownProviderError` (from #813), which propagates up through `phase-loop.ts`'s `spawn-error` catch to `stage-comment` error path (FR-012, matches the spec's "no silent fallback" requirement).

## Test matrix (unit — `resolve-agent-for-phase.test.ts`)

1. Empty config → `{ provider: 'claude-code' }` (tier 5, model undefined).
2. `defaultsAgent: 'test-agent'`, no `agents` → `{ provider: 'test-agent' }`.
3. `agents.default = { model: 'X' }`, `defaultsAgent: 'Y'` → `{ provider: 'Y', model: 'X' }` (independent).
4. `agents.workflows.speckit-feature.default = { provider: 'A', model: 'M1' }`, `phase: 'implement'` → `{ provider: 'A', model: 'M1' }`.
5. `agents.workflows.speckit-feature.phases.implement = { model: 'M2' }` + case 4 → `{ provider: 'A', model: 'M2' }` (phase-tier model wins, workflow-tier provider survives).
6. `agents.default = { provider: 'D' }`, `workflow: 'unknown-workflow'` → `{ provider: 'D' }` (unknown workflow name falls through cleanly).
7. Phase-tier sets provider only, workflow-tier sets model only, `agents.default` sets both → phase-tier provider wins, workflow-tier model wins, `agents.default` ignored on both counts (verifies **independent walks find first-hit per tier**).

## pr-feedback resolution site

`PrFeedbackHandler.spawnClaudeForFeedback` calls `resolveAgentForPhase(this.config, item.workflowName, 'implement')` (Q1→B). Not modeled as a separate resolver — this is a caller-side choice.
