# Data Model: Gateway-route validate warning + doctor llm-gateway check

## External types (owned by #1198, imported)

```typescript
// from '@generacy-ai/generacy-plugin-claude-code' — do NOT define here
type GatewayRoute = 'subscription' | 'gateway';
declare function resolveRoute(model?: string): GatewayRoute;
// 'gateway' iff model contains '/'; undefined or no slash → 'subscription'
```

## Validate warning (packages/generacy/src/config/loader.ts)

```typescript
/**
 * Collect warnings for agent entries whose model resolves to the gateway
 * route while GENERACY_LLM_GATEWAY_URL is unset. Warnings-only; never throws.
 */
function collectGatewayWarnings(
  config: GeneracyConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[];
```

- Wired into `loadConfigWithWarnings` as
  `[...collectEffortWarnings(config), ...collectGatewayWarnings(config)]`.
- Emits only for entries that **explicitly set** `model` (D-2): early return
  `if (!entry?.model) return;`.
- Warning entry format (D-7):

```
${path}.model — set to '<model>' which resolves to the gateway route, but GENERACY_LLM_GATEWAY_URL is not set in this environment. The model will not route anywhere at spawn time.
```

### Walked paths

| Tier | Config path emitted |
|------|---------------------|
| Global default | `orchestrator.agents.default` |
| Workflow default | `orchestrator.agents.workflows.<wf>.default` |
| Phase override | `orchestrator.agents.workflows.<wf>.phases.<phase>` |
| Cockpit default | `cockpit.auto.agents.default` |
| Cockpit role | `cockpit.auto.agents.<role>` |

Cockpit roles: `clarifier`, `reviewer`, `validator`, `fixer`, `diagnoser`
(matches `COCKPIT_AGENT_ROLES` in `packages/cockpit/src/config/schema.ts`).

### Cockpit duck-walk shape (D-3)

`GeneracyConfigSchema` gains `cockpit: z.unknown().optional()` — no shape
assertion. The walk narrows step-by-step; any failure yields no warnings, no
crash:

```typescript
// pseudo-shape the walk tolerantly expects
cockpit?: {
  auto?: {
    agents?: {
      default?: { model?: string };   // AgentEntry-like
      clarifier?: { model?: string };
      reviewer?: { model?: string };
      validator?: { model?: string };
      fixer?: { model?: string };
      diagnoser?: { model?: string };
    };
  };
};
```

Each level guarded with `typeof x === 'object' && x !== null`; `model` read
only when `typeof entry.model === 'string'`.

## Doctor check (packages/generacy/src/cli/commands/doctor/checks/llm-gateway.ts)

```typescript
const llmGatewayCheck: CheckDefinition = {
  id: 'llm-gateway',
  label: 'LLM Gateway',
  category: 'services',       // 5 s runner network timeout applies
  priority: 'P1',
  dependencies: ['config'],   // D-4: NOT ['env-file']
  run(context: CheckContext): Promise<CheckResult>,
};
```

Env reads: `context.envVars?.[K] ?? process.env[K]` for
`GENERACY_LLM_GATEWAY_URL` and `GENERACY_LLM_GATEWAY_TOKEN` (Q2=C).

### Decision matrix

| # | Condition | Status | Message / detail |
|---|-----------|--------|------------------|
| 1 | URL unset | `skip` | gateway not configured |
| 2 | URL set, token missing/empty | `fail` (no fetch) | token suggestion (Q4=A) |
| 3 | `GET /v1/models` → 200 | `pass` | model list from `data[].id` best-effort in detail (FR-009) |
| 4 | `GET /v1/models` → 401 | `fail` | token suggestion |
| 5 | `GET /v1/models` → 404/405 | fall through to fallback probe (Q3=C) |
| 6 | `GET /v1/models` → other non-200 | `fail` | `HTTP <status>` in detail |
| 7 | Fallback: no gateway-routed model in config | `warn` | reachable but unverifiable (D-5) |
| 8 | `POST /v1/messages` → 200 | `pass` | — |
| 9 | `POST /v1/messages` → 401 | `fail` | token suggestion |
| 10 | `POST /v1/messages` → other non-200 (incl. 404/405) | `fail` | `HTTP <status>` in detail (FR-010) |
| 11 | Network error / timeout (either request) | `fail` | reachability suggestion + `error.message` in detail |

### Probe requests

```
GET <url>/v1/models
  Authorization: Bearer <token>
  signal: AbortSignal.timeout(2_000)

POST <url>/v1/messages           # only on 404/405 from GET
  Authorization: Bearer <token>
  content-type: application/json
  body: { "model": "<first gateway-routed model from config>",
          "max_tokens": 1,
          "messages": [{ "role": "user", "content": "ping" }] }
  signal: AbortSignal.timeout(2_000)
```

Fallback model search order: `orchestrator.agents.default` → workflow
defaults → phase overrides → cockpit block (same walk order as the warning).

## Schema change (packages/generacy/src/config/schema.ts)

```typescript
export const GeneracyConfigSchema = z.object({
  // ...existing keys unchanged...
  cockpit: z.unknown().optional(),   // NEW: lenient passthrough (D-3)
});
```

No other schema changes. Cockpit's own loader keeps parsing the block with
its own semantics; this passthrough only stops Zod stripping the bytes.
