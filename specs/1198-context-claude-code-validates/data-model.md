# Data Model: Model-name route resolution + gateway CLAUDE_CONFIG_DIR env

**Feature**: #1198 · **Branch**: `1198-context-claude-code-validates`

## Entities

### Route

```ts
type Route = 'subscription' | 'gateway';
```

Derived purely from the model string — never stored, never configured.

| Input model | Route | Why |
|---|---|---|
| `undefined` | `subscription` | CLI default model (FR-001) |
| `opus`, `sonnet` (aliases) | `subscription` | no `/` |
| `claude-opus-4-7` | `subscription` | no `/` |
| `claude-sonnet-4-5[1m]` | `subscription` | `[1m]` suffix has no `/` |
| `openai/gpt-5.5` | `gateway` | contains `/` |
| `openrouter/qwen/qwen3.5-coder` | `gateway` | contains `/` (multi-segment fine) |

### LaunchSpec (plugin-local, `claude-code-launch-plugin.ts`)

```ts
interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  stdioProfile?: string;
  route?: 'gateway';          // NEW — informational, gateway launches only
}
```

**Invariants**:
- `route` type deliberately excludes `'subscription'` — stamping it on a subscription launch is a compile error (Q1=A).
- Subscription and `buildInvokeLaunch` specs omit both `route` and the gateway `env` key entirely; the subscription branch returns the builder's base object unmodified → strict deep-equal to pre-change output (FR-004).
- Gateway specs carry exactly `env: { CLAUDE_CONFIG_DIR: <gatewayConfigDir> }` and `route: 'gateway'` (FR-003, FR-007).
- `command`/`args`/`stdioProfile` are identical across routes for the same intent modulo the model string itself (FR-009, Q4=A).
- Orchestrator's own `LaunchSpec` is NOT modified; width subtyping preserves the registration seam.

### ClaudeCodeLaunchPluginOptions

```ts
interface ClaudeCodeLaunchPluginOptions {
  gatewayConfigDir?: string;
}
```

Resolution (once, in the constructor — FR-002, Q2=A):

```
explicit option  >  GENERACY_CLAUDE_GATEWAY_CONFIG_DIR env  >  '/home/node/.claude-gateway'
```

`??` (nullish) chaining: only `undefined`/`null` fall through. All ~15 existing `new ClaudeCodeLaunchPlugin()` call sites compile and behave unchanged.

### GatewayRouteUnavailableError

```ts
class GatewayRouteUnavailableError extends Error {
  readonly model: string;
  readonly gatewayConfigDir: string;
  // name === 'GatewayRouteUnavailableError'
}
```

**Validation rules**:
- Thrown by builders (via `assertGatewayProvisioned`) only when route is `gateway` AND `<gatewayConfigDir>/settings.json` does not exist (FR-005).
- Message MUST name: the model, the gateway config dir, and `GENERACY_LLM_GATEWAY_URL` (the operator's provisioning pointer) — SC-003.
- Standalone `Error` subclass — NOT a `PluginError` (its `ErrorCode` enum is session/container-oriented).

### Gateway provision cache (module-level, `route.ts`)

```ts
const provisionedDirs = new Set<string>();   // positive results only
```

**Semantics (FR-006, Q3=A)**:
- Keyed per gateway dir path (supports multiple plugin instances with different dirs in one process).
- Positive result cached for process lifetime — once `settings.json` is seen, never re-stat that dir.
- Negative result NEVER cached — re-stat on every gateway launch while missing, so provisioning takes effect immediately.
- Test seam: `_resetGatewayProvisionCacheForTests()` clears the set (mirrors `_setHasEffortMechanismForTests`).

## Relationships

```
intent.model ──resolveRoute──▶ Route
                                 │ 'subscription' → spec returned as-is (no env, no route key)
                                 │ 'gateway'      → assertGatewayProvisioned(model, gatewayConfigDir)
                                 │                    │ settings.json present → cache + inject
                                 │                    └ absent → throw GatewayRouteUnavailableError
                                 ▼
LaunchSpec{ env: {CLAUDE_CONFIG_DIR}, route:'gateway' }
                                 │
                                 ▼
AgentLauncher env merge (agent-launcher.ts:106-114) → spawned CLI sees CLAUDE_CONFIG_DIR
```

## Non-entities (explicit)

- `AgentEntrySchema.model` (`packages/config/src/template-schema.ts:22-28`) — stays free-form `string`; no schema change (FR-008).
- Orchestrator `LaunchSpec` — unchanged.
- `InvokeIntent` — carries no model; `buildInvokeLaunch` never gains `route` or gateway env.
- Gateway `settings.json` contents — provisioned out-of-band; this feature only checks presence.
