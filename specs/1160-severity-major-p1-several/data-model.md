# Data Model: Per-workflow/agent config keys parse but do not apply

This feature widens two existing types by one optional field each and adds one
pure resolver function. No new entities, no persistence, no cross-package public
surface beyond the additive `WorkflowOverride` field.

## Widened type — `WorkflowOverride` (`@generacy-ai/config`)

`WorkflowOverrideSchema` (template-schema.ts) is `.strict()`. Add one optional
field:

| Field | Type | Constraint | Notes |
|-------|------|-----------|-------|
| `validateCommand` | `string?` | optional | unchanged |
| `preValidateCommand` | `string?` | optional | unchanged; `""` = skip install |
| `maxRemediations` | `number?` | int, ≥ 0, optional | unchanged |
| `review` | `WorkflowReview?` | optional | unchanged |
| **`ciWaitTimeoutMs`** | **`number?`** | **int, ≥ 30_000, optional** | **NEW — makes documented YAML parse (FR-006)** |

- `.strict()` is preserved: unknown keys still rejected. The point of the change
  is that `ciWaitTimeoutMs` stops being unknown.
- `.min(30_000)` mirrors the `WorkerConfigSchema.ciWaitTimeoutMs` bound
  (config.ts:157) so an override cannot undercut the cluster-level floor.
- Additive + optional ⇒ backward-compatible; existing configs parse unchanged.

## Widened type — `ResolvedWorkflowConfig` (`@generacy-ai/orchestrator`)

`ResolvedWorkflowConfig` (config.ts:38-47) is the return type of
`resolveWorkflowOverrides`. Add one required field (always resolved to a number):

| Field | Type | Resolution | Tiers |
|-------|------|-----------|-------|
| `validateCommand` | `string` | `wf ?? repo ?? cluster` | workflow → `settings.validateCommand` → `config.validateCommand` |
| `preValidateCommand` | `string` | `wf ?? repo ?? cluster` | workflow → `settings.preValidateCommand` → `config.preValidateCommand` |
| `maxRemediations` | `number` | `wf ?? default(w)` | workflow → `defaultMaxRemediations(workflowName)` |
| `review` | object | `wf ?? DEFAULT_REVIEW` | workflow → built-in default |
| **`ciWaitTimeoutMs`** | **`number`** | **`wf ?? cluster`** | **workflow → `config.ciWaitTimeoutMs` (no repo tier — mirrors `maxRemediations`)** |

Resolution rule (added to `resolveWorkflowOverrides`, config.ts:70-81):
```ts
ciWaitTimeoutMs: wf?.ciWaitTimeoutMs ?? config.ciWaitTimeoutMs,
```
`??` preserves an explicit workflow value including any legal ≥30_000 number;
absence falls through to the cluster base (fed by `WORKER_CI_WAIT_TIMEOUT_MS`).

## New function — `resolveReviewLikeAgent` (`@generacy-ai/orchestrator`)

Pure function in config.ts, beside `resolveAgentForPhase`. Resolves the agent for
the `review` / `remediate` phases with field-by-field fallback to the `implement`
agent.

```ts
export function resolveReviewLikeAgent(
  config: WorkerConfig,
  workflowName: string,
  phase: 'review' | 'remediate',
): { provider: string; model?: string; effort?: Effort }
```

**Behavior** (per FR-005 / Q1=A / Q3=A):
1. `base = resolveAgentForPhase(config, workflowName, 'implement')` — the full
   implement-tier resolution (its own precedence + `DEFAULT_PROVIDER` fallback).
2. `tier = config.agents?.workflows?.[workflowName]?.phases?.[phase]` — the
   `phases.review` / `phases.remediate` entry (may be undefined or partial).
3. Per field, prefer the phase tier, else the implement `base`:
   - `provider = tier?.provider ?? base.provider`
   - `model    = tier?.model    ?? base.model`
   - `effort   = tier?.effort   ?? base.effort`
4. Reassemble with the same optional-field discipline as `resolveAgentForPhase`
   (only attach `model`/`effort` when defined).

**Agent-resolution matrix** (SC-003 acceptance):

| `phases.<phase>` set fields | Resolved provider | Resolved model | Resolved effort |
|-----------------------------|-------------------|----------------|-----------------|
| none (tier undefined) | implement provider | implement model | implement effort |
| `model` only | implement provider | **phase model** | implement effort |
| `provider` + `effort` | **phase provider** | implement model | **phase effort** |
| all three | phase provider | phase model | phase effort |

For `phase: 'remediate'`, the `base` is always the `implement` resolution — the
`review` tier is never consulted (Q3=A): a cheaper `phases.review` model cannot
downgrade the code-writing remediate phase.

## Validation rules

- `ciWaitTimeoutMs` override: integer ≥ 30_000 (ms). Non-integer / < 30_000 /
  non-number ⇒ Zod parse error (loud rejection, satisfying FR-007's "change
  behavior or reject" for malformed values).
- Unknown keys under `workflows.<name>`: still rejected by `.strict()`.
- `preValidateCommand` empty string: valid; resolves through `??` and skips
  install via the existing `if (cmd)` truthiness guard.

## Call-site wiring (no type change, behavior change)

| Call site | Before | After |
|-----------|--------|-------|
| phase-loop.ts:662 | `config.preValidateCommand` (raw) | `resolveWorkflowOverrides(...).preValidateCommand` |
| phase-loop.ts:696 | `config.validateCommand` (raw seed) | `resolveWorkflowOverrides(...).validateCommand` |
| phase-loop.ts:1333 | `config.ciWaitTimeoutMs` (raw) | `resolveWorkflowOverrides(...).ciWaitTimeoutMs` |
| review-executor.ts:126 | `resolveAgentForPhase(config, w, 'implement')` | `resolveReviewLikeAgent(config, w, 'review')` |
| remediate-executor.ts:98 | `resolveAgentForPhase(config, w, 'implement')` | `resolveReviewLikeAgent(config, w, 'remediate')` |

`resolveTargetedValidate` (phase-loop.ts:1815) is **unchanged** — it already
resolves per-workflow and overwrites `effectiveValidateCommand`, preserving
FR-002 by construction.
