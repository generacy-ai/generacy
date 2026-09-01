---
"@generacy-ai/generacy": minor
---

Gateway-route validate warning + doctor `llm-gateway` check (#1200).

`generacy validate` now emits a warning when a config entry explicitly sets a
`model` that resolves to the LLM gateway route (one containing `/`) while
`GENERACY_LLM_GATEWAY_URL` is unset in the environment — the model would not
route anywhere at spawn time. Warnings walk the orchestrator agent tiers
(`default`, workflow defaults, phases) plus the tolerant `cockpit.auto.agents.*`
block, name the exact config path, and stay on the warnings-only channel
(exit code 0).

`generacy doctor` gains an `llm-gateway` check (category `services`, P1): it
skips when `GENERACY_LLM_GATEWAY_URL` is unset, fails fast without fetching when
the URL is set but `GENERACY_LLM_GATEWAY_TOKEN` is missing, and otherwise probes
`GET /v1/models` (falling back to a single-token `POST /v1/messages` on 404/405)
with a 2s per-request timeout to confirm the gateway is reachable and
authenticated.
