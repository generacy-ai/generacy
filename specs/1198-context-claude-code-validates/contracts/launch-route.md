# Contract: Route resolution + gateway launch env injection

**Feature**: #1198 · **Module**: `packages/generacy-plugin-claude-code/src/launch/route.ts` + `claude-code-launch-plugin.ts`

## `resolveRoute(model?: string): Route`

Pure function. No I/O, no env reads, no cache.

| Input | Output |
|---|---|
| string containing `/` (anywhere, any count) | `'gateway'` |
| string with no `/` (ids, aliases, `[1m]` suffix) | `'subscription'` |
| `undefined` | `'subscription'` |
| `''` (empty string) | `'subscription'` (no `/`) |

Consumers needing route comparison (e.g. #1199 session invalidation) MUST call this directly — `LaunchSpec.route` is `undefined` on subscription launches and unsuitable for comparison (Q1 caveat).

## `resolveGatewayConfigDir(explicit?: string): string`

```
explicit ?? process.env.GENERACY_CLAUDE_GATEWAY_CONFIG_DIR ?? '/home/node/.claude-gateway'
```

Nullish chaining only — an explicit empty string wins over the env var (nothing in the engine passes the option today). Called once per plugin construction, not per launch.

## `assertGatewayProvisioned(model: string, gatewayConfigDir: string): void`

| State | Behavior |
|---|---|
| dir in positive cache | return (no fs access) |
| `<dir>/settings.json` exists | add dir to cache, return |
| `<dir>/settings.json` absent | throw `GatewayRouteUnavailableError` — nothing cached |

Cache is per-process, keyed by dir path, positive-only. `_resetGatewayProvisionCacheForTests()` clears it.

## `GatewayRouteUnavailableError`

- `instanceof Error` and `instanceof GatewayRouteUnavailableError` both true.
- `name === 'GatewayRouteUnavailableError'`.
- `.model` and `.gatewayConfigDir` populated.
- `.message` contains: the model string, the gateway config dir path, and the literal token `GENERACY_LLM_GATEWAY_URL`.

Example message shape:

```
Model "openrouter/qwen/qwen3.5-coder" requires the gateway route, but /home/node/.claude-gateway/settings.json was not found. Provision the gateway config dir (see GENERACY_LLM_GATEWAY_URL) or use an Anthropic model.
```

(Exact wording free; the three tokens above are the contract.)

## Builder contract (per builder)

Applies to all six model-bearing builders: `buildPhaseLaunch`, `buildPrFeedbackLaunch`, `buildMergeConflictLaunch`, `buildReviewLaunch`, `buildRemediateLaunch`, `buildConversationTurnLaunch`.

### Gateway model (`resolveRoute(model) === 'gateway'`, dir provisioned)

```ts
{
  ...preChangeSpec,                                  // command/args/stdioProfile byte-identical
  env: { CLAUDE_CONFIG_DIR: <gatewayConfigDir> },    // exactly this one key
  route: 'gateway',
}
```

- `args` identical to what the same intent with the same model string produced pre-change: `--model <provider/model>` verbatim, `--effort` still appended when set (FR-009, Q4=A).

### Gateway model, dir NOT provisioned

- Throws `GatewayRouteUnavailableError` synchronously from `buildLaunch`. No spec returned.

### Subscription model or `undefined` model

- Returned object is the builder's base object **as-is** — `expect(spec).toEqual(preChangeSpec)` strictly, and `expect(spec).not.toHaveProperty('env')`, `expect(spec).not.toHaveProperty('route')`.

### `buildInvokeLaunch`

- Out of scope entirely: no model, no route, no env — byte-identical forever under this feature.

## Registration seam

`ClaudeCodeLaunchPlugin` remains structurally assignable to the orchestrator's `AgentLaunchPlugin`. Orchestrator `LaunchSpec` is not modified; `route?` is additive (width subtyping). Existing `claude-code-launch-plugin-integration.test.ts` exercises this seam.

## Public exports (`src/index.ts`)

```ts
export { resolveRoute, GatewayRouteUnavailableError, DEFAULT_GATEWAY_CONFIG_DIR,
         _resetGatewayProvisionCacheForTests } from './launch/route.js';
export type { Route } from './launch/route.js';
export type { ClaudeCodeLaunchPluginOptions } from './launch/claude-code-launch-plugin.js';
```
