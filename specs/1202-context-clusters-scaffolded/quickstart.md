# Quickstart: LLM gateway (Bifrost) in scaffolded clusters

## Enable at scaffold time

```bash
# Flag form (launch or deploy)
generacy launch --claim=<code> --llm-gateway
generacy deploy ssh://user@host --llm-gateway

# Env form (equivalent)
GENERACY_LLM_GATEWAY_ENABLED=true generacy launch --claim=<code>
```

The toggle persists as `llmGateway: true` in `.generacy/cluster.yaml` — later scaffolds keep the
gateway without repeating the flag. Disable explicitly with `--no-llm-gateway` (or edit
cluster.yaml). Disabling removes only the compose stanza and service env vars; your
`llm-gateway/` config, `.env.local`, and the generated token are left untouched, and re-enabling
reuses them.

## What gets scaffolded

```
.generacy/
  docker-compose.yml       # + llm-gateway service (maximhq/bifrost:v2.0.0, cluster network only)
  .env                     # + GENERACY_LLM_GATEWAY_TOKEN=sk-bf-… (generated once)
  .env.local               # commented provider-key placeholders (yours to fill in)
  llm-gateway/
    config.example.json    # reference config (regenerated each scaffold)
    config.json            # live config, created from the example once — edit freely
    .gitignore             # ignores config.json
```

Orchestrator and worker containers receive `GENERACY_LLM_GATEWAY_URL=http://llm-gateway:8080/anthropic`
and `GENERACY_LLM_GATEWAY_TOKEN`.

## Add provider keys

Edit `.generacy/.env.local` and set any of:

- `OPENROUTER_API_KEY` — https://openrouter.ai/settings/keys, models as `openrouter/<vendor>/<model>`
- `FEATHERLESS_API_KEY` — https://featherless.ai/account/api-keys, models as `featherless/<HF repo>`
- `OPENAI_API_KEY` — https://platform.openai.com/api-keys, models as `openai/<model>` (API-key billing only)

Each key is optional: providers without keys are skipped at boot and calls to them return
HTTP 400 `no valid keys found for provider: <name>`. Then restart:

```bash
docker compose -f .generacy/docker-compose.yml up -d llm-gateway
```

## Edit routing config

`llm-gateway/config.json` is yours — the scaffolder never overwrites it. It holds only
`env.<VAR>` references, never key material. Bifrost merges it into its internal `config.db` on
every boot, so edit-and-restart is enough to add a provider or rotate the token. **Removals do
not propagate** — reset with `docker compose rm -sfv llm-gateway` (drops the `llm-gateway-data`
volume). Do **not** set `"source_of_truth": "config.json"` — v2.0.0 crash-loops when the virtual
key's env ref is unresolved.

## Verify

```bash
# From inside the cluster network (e.g. docker compose exec orchestrator bash):
curl -sS http://llm-gateway:8080/health

TOKEN=$(grep '^GENERACY_LLM_GATEWAY_TOKEN=' .generacy/.env | cut -d= -f2)
curl -N -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  http://llm-gateway:8080/anthropic/v1/messages \
  -d '{"model":"openrouter/<vendor>/<model>","max_tokens":32,"stream":true,
       "messages":[{"role":"user","content":"ping"}]}'
```

A streamed completion confirms end-to-end routing (SC-004).

```bash
# Doctor check (skips when the gateway is not configured):
generacy doctor
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Every call 401s | Token missing the `sk-bf-` prefix. Bifrost only accepts unprefixed virtual keys on the `x-bf-vk` header, which Claude Code never sends. Regenerate as `sk-bf-$(openssl rand -hex 24)` in `.env` and restart. |
| HTTP 400 `no valid keys found for provider: X` | That provider's key is empty in `.env.local`. Harmless unless you route to it. |
| `count_tokens` errors in logs | Expected on non-Anthropic upstreams; Claude Code falls back to client-side counting. Disable via `allowed_requests` if noisy. |
| Gateway crash-loops with `failed to prune governance config … FOREIGN KEY constraint failed` | `source_of_truth: "config.json"` set while the token env ref is unresolved. Remove that key. |
| Gateway won't start / APP_DIR errors | The `llm-gateway-data` named volume is required; don't replace it with a host bind (process runs as 1000:0). |
| Provider removed from config.json still active | Removals don't propagate (split reconciliation). `docker compose rm -sfv llm-gateway` to reset. |
| Can't reach the gateway from the host | By design — no host port. Add `ports: ["8090:8080"]` locally to inspect the management UI / request logs. |
