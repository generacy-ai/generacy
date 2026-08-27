# Quickstart: Gateway-route validate warning + doctor llm-gateway check

## Prerequisite

`resolveRoute` must be shipped by generacy-ai/generacy#1198:

```bash
grep -rn "export.*resolveRoute" packages/generacy-plugin-claude-code/src/
# no match → implementation blocks/requeues (Q1=A)
```

## Build

```bash
pnpm install
pnpm -r build
```

## Reproduce the validate warning

With a gateway-shaped model in `.generacy/config.yaml`:

```yaml
orchestrator:
  agents:
    default:
      model: bifrost/claude-opus-4-7   # contains '/' → gateway route
```

```bash
unset GENERACY_LLM_GATEWAY_URL
generacy validate
# → warning: orchestrator.agents.default.model — set to 'bifrost/claude-opus-4-7'
#   which resolves to the gateway route, but GENERACY_LLM_GATEWAY_URL is not set...
# exit code 0 (warnings-only)

GENERACY_LLM_GATEWAY_URL=http://gateway:8080 generacy validate
# → silent (no gateway warning)
```

A slash-less model (`model: opus`) never warns regardless of env.

## Exercise the doctor check

```bash
# URL unset → skip
generacy doctor --check llm-gateway

# URL set, token missing → fail (token suggestion), no request issued
GENERACY_LLM_GATEWAY_URL=http://gateway:8080 generacy doctor --check llm-gateway

# URL + token set → probes GET <url>/v1/models with Authorization: Bearer;
# falls back to a 1-token POST /v1/messages on 404/405
GENERACY_LLM_GATEWAY_URL=http://gateway:8080 \
GENERACY_LLM_GATEWAY_TOKEN=sk-... \
generacy doctor --check llm-gateway
```

Outcomes: 200 → pass (model list in detail when `/v1/models` provides one);
401 → fail (token); other non-200 → fail (`HTTP <status>`); connection
refused/timeout → fail (reachability).

## Tests

```bash
pnpm --filter @generacy-ai/generacy test -- gateway-warnings
pnpm --filter @generacy-ai/generacy test -- llm-gateway
```

## Troubleshooting

- **Check skipped but you have a gateway**: the URL isn't visible to the
  doctor process — it reads `.generacy/generacy.env` values first, then the
  process env. Compose-injected values need the doctor run inside the
  container that receives them.
- **401 fail with a valid token**: the check sends
  `Authorization: Bearer <token>` (what real launches send). If your gateway
  expects `x-api-key`, it will not work at spawn time either.
- **warn "reachable but unverifiable"**: gateway answered but has no
  `/v1/models`, and no gateway-routed model exists in config for the fallback
  probe. Add a gateway-shaped model to config or enable discovery on the
  gateway.
