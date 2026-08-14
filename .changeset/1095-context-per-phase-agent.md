---
"@generacy-ai/config": minor
"@generacy-ai/generacy-plugin-claude-code": minor
"@generacy-ai/generacy": minor
"@generacy-ai/orchestrator": patch
---

Add optional per-phase `effort` alongside `model` on the `orchestrator.agents` block (#1095), and bring the two fixer paths that ignored agent config into parity with `pr-feedback-handler`.

- `@generacy-ai/config`: new `EffortSchema` enum (`low | medium | high | xhigh | max`), new optional `effort` field on `AgentEntrySchema`, and `.strict()` on `AgentEntrySchema` / `WorkflowAgentEntriesSchema` (both levels) / `AgentsConfigSchema`. Typos inside `orchestrator.agents` (`defualt:`, `implment:`, `efort:`) now fail validation; typos outside the block continue to strip silently.
- `@generacy-ai/generacy-plugin-claude-code`: new public static `ClaudeCodeLaunchPlugin.hasEffortMechanism()` (returns `true` under Claude CLI v2.1.150 which exposes `--effort <level>`). `--effort` is now appended by all four builders (`buildPhaseLaunch`, `buildPrFeedbackLaunch`, `buildValidateFixLaunch`, `buildMergeConflictLaunch`). `buildValidateFixLaunch` and `buildMergeConflictLaunch` also gain the `--model` push previously missing on those two paths.
- `@generacy-ai/generacy`: new `loadConfigWithWarnings` helper + `warnings` field on `generacy validate --json` output. When `effort` is set but the resolved provider has no CLI mechanism for effort in this release, a warning naming both `effort` and the provider is surfaced (exit code stays 0). New "Orchestrator Agent Selection" section in `docs/docs/getting-started/configuration.md` and an updated `packages/generacy/examples/config-full.yaml` demonstrate the block with `effort:`.
- `@generacy-ai/orchestrator`: internal plumbing only — `mergeAgentEntry` and `resolveAgentForPhase` learn to walk `effort` as a fourth independent field; `CliSpawnOptions` + `PhaseIntent` / `PrFeedbackIntent` / `ValidateFixIntent` / `MergeConflictIntent` gain the field; `validate-fix-handler` and `merge-conflict-handler` now call `resolveAgentForPhase(config, workflowName, 'implement')` and forward `{ provider, model, effort }` to their intents and `LaunchRequest.provider`. `cli-spawner` emits one `agent.effort.dropped` warn line per spawn when `effort` cannot be delivered.

Behavior-preserving: any repo with no `agents` block, or with `agents` set but `effort` unset, produces byte-identical argv + env across all four spawn paths (SC-004).
