---
"@generacy-ai/generacy": minor
---

Add an opt-in LLM gateway (Bifrost) sidecar to scaffolded clusters (#1202). A
`--llm-gateway` / `--no-llm-gateway` flag (or `GENERACY_LLM_GATEWAY_ENABLED=true`)
on `launch` and `deploy` emits an `llm-gateway` compose service, a generate-once
`sk-bf-` token in `.env`, `llm-gateway/config.example.json` + create-if-absent
`config.json`, and a commented `.env.local`. The toggle persists as
`llmGateway: true` in `cluster.yaml`; disabled output stays byte-identical.
