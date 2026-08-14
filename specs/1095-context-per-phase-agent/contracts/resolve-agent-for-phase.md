# Contract: resolveAgentForPhase (extended return)

**Location**: `packages/orchestrator/src/worker/config.ts:280-295`.

## Public signature

```ts
export function resolveAgentForPhase(
  config: WorkerConfig,
  workflowName: string,
  phase: WorkflowPhase,
): { provider: string; model?: string; effort?: Effort };
```

## Precedence chain (independent per field)

Each of `provider`, `model`, `effort` walks the same 3-tier list independently:

1. `config.agents?.workflows?.[workflowName]?.phases?.[phase]`
2. `config.agents?.workflows?.[workflowName]?.default`
3. `config.agents?.default`

`provider` additionally falls back to:

4. `config.defaultsAgent` (bare string)
5. `DEFAULT_PROVIDER = 'claude-code'`

`model` and `effort` walks terminate at tier 3 returning `undefined`.

## Independence invariant

Setting a single field at any tier does NOT force the sibling fields to be re-specified at the same tier. Example:

```yaml
orchestrator:
  agents:
    default:
      provider: claude-code
      model: sonnet
    workflows:
      speckit-feature:
        phases:
          implement:
            effort: high  # Only effort is overridden at phase tier.
```

Result for `resolveAgentForPhase(config, 'speckit-feature', 'implement')`:
```
{ provider: 'claude-code', model: 'sonnet', effort: 'high' }
```

The `provider` and `model` fall through to `agents.default` untouched.

## SC-002 test case

**Config**:
```yaml
orchestrator:
  agents:
    workflows:
      speckit-feature:
        phases:
          plan:
            model: fable
            effort: xhigh
          implement:
            model: opus
            effort: high
```

**Expected**:
- `resolveAgentForPhase(config, 'speckit-feature', 'plan')` → `{ provider: 'claude-code', model: 'fable', effort: 'xhigh' }`
- `resolveAgentForPhase(config, 'speckit-feature', 'implement')` → `{ provider: 'claude-code', model: 'opus', effort: 'high' }`

## Backward compat

Any repo with no `agents` block or with `effort` unset at every tier produces a return whose `effort` field is absent (`undefined`). Callers that spread `...(effort !== undefined ? { effort } : {})` into intents produce byte-identical intents to today (SC-004).
