---
"@generacy-ai/generacy-plugin-claude-code": minor
---

Model-name route resolution + `CLAUDE_CONFIG_DIR` gateway env in every launch builder (#1198).

Adds `resolveRoute(model?)` — a pure function that routes any provider-qualified
model (one containing `/`, e.g. `openai/gpt-5.5`) to a second CLI config dir whose
`settings.json` points at the Generacy LLM gateway, while bare Anthropic ids/aliases
(and an absent model) stay on the subscription config. The six model-bearing launch
builders now inject `CLAUDE_CONFIG_DIR` and stamp `route: 'gateway'` for gateway
models; subscription launches are byte-identical to before (no `env`, no `route`).

New public surface: `resolveRoute`, `GatewayRouteUnavailableError`,
`DEFAULT_GATEWAY_CONFIG_DIR`, `_resetGatewayProvisionCacheForTests`, the `Route`
type, and `ClaudeCodeLaunchPluginOptions` (`{ gatewayConfigDir? }`). The gateway
config dir resolves via explicit option > `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR` >
`/home/node/.claude-gateway`; a missing `settings.json` raises
`GatewayRouteUnavailableError` at launch time.
