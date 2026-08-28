# Contract: env file additions

## `.generacy/.env` (scaffolder-owned, regenerated; token line has generate-once semantics)

Appended by `scaffoldEnvFile` when the gateway is enabled (or when a token already exists in the
file being regenerated, enabled or not):

```bash
# LLM gateway (Bifrost sidecar)
# Cluster-local token Claude Code presents to the gateway; generated once, never
# rotated by the scaffolder. The sk-bf- prefix is REQUIRED — Bifrost 401s
# unprefixed Bearer tokens.
GENERACY_LLM_GATEWAY_TOKEN=sk-bf-<48 hex chars>
```

Constraints:
- Token matches `^sk-bf-[0-9a-f]{48}$`.
- An existing token value is always preserved verbatim on re-scaffold (enabled or disabled).
- When the gateway is disabled and no token exists, this section is absent — the `.env` is
  byte-identical to current output.

## `.generacy/.env.local` (operator-owned; create-if-absent, never overwritten, enabled only)

```bash
# LLM gateway provider keys (secrets — do not commit; this file is gitignored)
# Each key is optional: a provider whose key is absent is skipped at boot, and
# calls to it return HTTP 400 "no valid keys found for provider: <name>". The
# gateway still starts and stays healthy (fails closed).
#
# Note: /v1/messages/count_tokens is not supported by non-Anthropic upstreams —
# Claude Code falls back to client-side context counting. Custom providers scope
# accepted request types via custom_provider_config.allowed_requests in
# llm-gateway/config.json.

# https://openrouter.ai/settings/keys — models addressed as openrouter/<vendor>/<model>
OPENROUTER_API_KEY=

# https://featherless.ai/account/api-keys — models addressed as featherless/<HF repo>
FEATHERLESS_API_KEY=

# https://platform.openai.com/api-keys — models addressed as openai/<model>
# API-key billing only; ChatGPT/Codex subscriptions are not supported behind a
# shared gateway.
OPENAI_API_KEY=
```

No `.env.local.template` is emitted (clarify Q3).

## `.generacy/llm-gateway/.gitignore` (create-if-absent)

```
config.json
```

`config.example.json` stays tracked/regenerable; `config.json` may be hand-edited and may
diverge, so it is gitignored and never overwritten.
