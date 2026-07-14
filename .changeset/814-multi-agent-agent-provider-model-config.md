---
"@generacy-ai/config": minor
"@generacy-ai/orchestrator": minor
"@generacy-ai/generacy-plugin-claude-code": minor
"@generacy-ai/generacy": minor
---

Agent provider/model config surface threaded to phase spawns (#814).

Adds an `orchestrator.agents` config block so a repo's `.generacy/config.yaml`
can select the agent `{ provider, model }` per workflow phase. Ships immediate
value: per-phase **model** selection for Claude Code, ahead of any new provider.

- `@generacy-ai/config`: `OrchestratorSettingsSchema` gains an `agents` block
  (`default` / `workflows.<name>.default` / `workflows.<name>.phases.<phase>`,
  each `{ provider?, model? }`).
- `@generacy-ai/generacy`: mirrors the `agents` block in the CLI-facing config
  schema and `examples/config-*.yaml`, and wires the previously-unconsumed
  `defaults.agent` as the repo-level provider default.
- `@generacy-ai/orchestrator`: `WorkerConfigSchema` carries the merged `agents`
  block; the repo-override merge and cluster-default env plumbing
  (`WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL`) are extended. New
  `resolveAgentForPhase(config, workflowName, phase)` implements precedence
  (`phases.<phase>` > `workflows.<name>.default` > `agents.default` > repo
  `defaults.agent` > cluster default > built-in `claude-code`), resolving
  provider and model independently. `{ provider, model }` is threaded through
  `CliSpawnOptions` → intent → `LaunchRequest`; provider-aware resume drops the
  session when the next phase resolves to a different provider, and an unknown
  provider fails the phase with a clear message (no silent Claude fallback).
- `@generacy-ai/generacy-plugin-claude-code`: `ClaudeCodeLaunchPlugin` pushes
  `--model` on `phase`/`pr-feedback` intents when set, mirroring the existing
  conversation-turn path. No-config argv output is unchanged.
