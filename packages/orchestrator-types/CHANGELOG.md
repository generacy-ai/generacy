# @generacy-ai/orchestrator-types

## 0.2.0

### Minor Changes

- 5488c4c: Provider-neutral launch intents and a `(provider, kind)` plugin registry (#813).

  - `@generacy-ai/orchestrator`: the agent launch intent types (`phase`,
    `pr-feedback`, `validate-fix`, `merge-conflict`, `conversation-turn`,
    `invoke`) now live in and are owned by `src/launcher/types.ts` — the core
    `LaunchIntent` union no longer imports `ClaudeCodeIntent` from the Claude
    plugin, so the concrete provider no longer leaks into orchestrator core.
    `PhaseIntent`/`PrFeedbackIntent` gain an optional `model` field and
    `LaunchRequest` gains an optional `provider` selector (default
    `'claude-code'`). The launcher registry is re-keyed on `(provider, kind)`,
    keeping duplicate-registration protection per key, and an unknown provider
    produces a typed error. These types are also exposed via the new
    `@generacy-ai/orchestrator/launcher/types` subpath export.
  - `@generacy-ai/orchestrator-types`: `LaunchRequest` and `AgentLaunchPlugin`
    gain the `provider` field mirroring the orchestrator-owned contract.
  - `@generacy-ai/generacy-plugin-claude-code`: `ClaudeCodeLaunchPlugin` declares
    its `provider` namespace. The plugin structurally mirrors the
    orchestrator-owned intent types locally (same pattern as its local
    `LaunchSpec`/`OutputParser`) rather than importing them across the package
    boundary, so the two packages do not form a build-time cycle. No call-site
    behavior change — all sites resolve to the `claude-code` provider and argv
    output is byte-identical.
