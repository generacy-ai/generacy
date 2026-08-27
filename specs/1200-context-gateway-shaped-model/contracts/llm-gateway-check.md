# Contract: `llm-gateway` doctor check

## Identity (D-6)

| Field | Value |
|-------|-------|
| `id` | `llm-gateway` |
| `label` | `LLM Gateway` |
| `category` | `services` (5 s runner network timeout) |
| `priority` | `P1` |
| `dependencies` | `['config']` (D-4 — NOT `['env-file']`) |
| Registration | `createDefaultRegistry()` after `agencyMcpCheck` |

## Env source (Q2=C, FR-007)

```typescript
const url = context.envVars?.GENERACY_LLM_GATEWAY_URL ?? process.env.GENERACY_LLM_GATEWAY_URL;
const token = context.envVars?.GENERACY_LLM_GATEWAY_TOKEN ?? process.env.GENERACY_LLM_GATEWAY_TOKEN;
```

Accepted caveat: in a full `generacy doctor` run the check shares a tier with
`env-file`, whose `data` merge lands after same-tier siblings start —
`context.envVars` is typically still `null` and `process.env` dominates.
Under `--check llm-gateway` the envVars path is genuinely absent. Both are
correct per Q2=C (compose-env clusters must not be skipped).

## Behavior matrix (SC-002 test targets)

| Scenario | Result |
|----------|--------|
| URL unset (both sources) | `skip` — "gateway not configured" (FR-007) |
| URL set, token missing/empty | `fail` + token suggestion, **fetch never called** (Q4=A, FR-012) |
| `GET /v1/models` 200 | `pass`; parse `data[].id` best-effort into detail (FR-009) |
| `GET /v1/models` 401 | `fail` + token suggestion |
| `GET /v1/models` 404 or 405 | fall back to `POST /v1/messages` (Q3=C, FR-008) |
| `GET /v1/models` other non-200 | `fail`, `HTTP <status>` in detail |
| Fallback needed, no gateway-routed model in config | `warn` — reachable but unverifiable (D-5) |
| `POST /v1/messages` 200 | `pass` |
| `POST /v1/messages` 401 | `fail` + token suggestion |
| `POST /v1/messages` any other non-200 (incl. 404/405) | `fail`, `HTTP <status>` in detail (FR-010 — fallback-trigger exception applies to the primary only) |
| Network error / timeout on either request | `fail` + reachability suggestion, `error.message` in detail |

## Requests (Q5=A, D-5)

- Auth header on both: `Authorization: Bearer <token>` — the same header real
  launches send via `ANTHROPIC_AUTH_TOKEN`, so a green check predicts a
  working spawn. Never `x-api-key`.
- Per-request `AbortSignal.timeout(2_000)` — primary + fallback fit the
  runner's 5 s `services` budget with headroom.
- Fallback body: `{ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }`
  where `model` is the first config entry with `resolveRoute(model) === 'gateway'`
  (walk order: `orchestrator.agents.default` → workflow defaults → phases →
  cockpit block).
- Timeout detection mirrors `anthropic-key.ts`:
  `error instanceof DOMException && error.name === 'TimeoutError'`.

## Test harness (SC-002)

`vi.stubGlobal('fetch', vi.fn())` — assert fetch **not called** on the
token-missing branch; assert the fallback `POST /v1/messages` request is
issued after a 404 primary; envVars-vs-process.env precedence covered by
constructing `CheckContext` with and without `envVars`.
