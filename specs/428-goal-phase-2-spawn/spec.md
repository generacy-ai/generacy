# Feature Specification: ## Goal

Phase 2 of the [spawn refactor](https://github

**Branch**: `428-goal-phase-2-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

## Goal

Phase 2 of the [spawn refactor](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-2--extract-claudecodelaunchplugin). Create `ClaudeCodeLaunchPlugin` inside `@generacy-ai/generacy-plugin-claude-code`. After this issue lands, `AgentLauncher` can handle `pluginId: "claude-code"` but no caller uses it yet — Wave 3 flips the callers.

## Scope

- Create `ClaudeCodeLaunchPlugin` inside [packages/generacy-plugin-claude-code](https://github.com/generacy-ai/generacy/tree/develop/packages/generacy-plugin-claude-code). The package continues to export `ClaudeCodePlugin` (Latency `AbstractDevAgentPlugin` base, container-managed) and adds the new launch plugin as a sibling export. Resolved open question #3: a single plugin package can implement both interfaces.
- Implement the `AgentLaunchPlugin` interface from Wave 1. Copy the following into the plugin WITHOUT deleting from orchestrator internals (Wave 3 cleanup does the deletion):
  - `PHASE_TO_COMMAND` map from [packages/orchestrator/src/worker/types.ts:73-80](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/worker/types.ts#L73-L80)
  - Claude CLI flags: `--verbose`, `--resume`, `--output-format stream-json`, `--dangerously-skip-permissions`
  - PTY wrapper Python script currently embedded in [packages/orchestrator/src/conversation/conversation-spawner.ts:99](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/conversation/conversation-spawner.ts#L99) (resolved open question #4: PTY wrapper belongs here, not in the generic launcher)
- Implement `buildLaunch(intent, params)` for each supported intent:
  - `{ kind: "phase", phase: "specify" | "clarify" | "plan" | "tasks" | "implement", sessionId? }` → `claude <phase-command>` + resume flags if sessionId provided. `validate` is excluded from `PhaseIntent.phase` type (compile-time prevention) — the validate phase runs via `GenericSubprocessPlugin` as a `{ kind: "shell" }` intent.
  - `{ kind: "pr-feedback", prNumber: number, prompt: string }` → `claude -p <prompt> --output-format stream-json` with PR context. The caller (PrFeedbackHandler) pre-builds the prompt via `buildFeedbackPrompt()` and passes it on the intent. `prNumber` is retained for logging/tracing.
  - `{ kind: "conversation-turn", message: string, sessionId?: string, model?: string, skipPermissions: boolean }` → `python3 -u -c <PTY_WRAPPER> claude ...` with interactive stdio. Fields are flattened directly on the intent (no nested `turn` object). `cwd` is a spawn-level concern on `LaunchRequest.cwd`.
- CLI flags: `--verbose` is always included for all intents. `--dangerously-skip-permissions` is always included for `phase` and `pr-feedback` intents, but conditional on `skipPermissions` for `conversation-turn`.
- Implement `createOutputParser(intent: LaunchIntent)` returning the appropriate parser (stream-json for phase / pr-feedback, PTY output parser for conversation-turn). Requires updating the Wave 1 `AgentLaunchPlugin` interface to accept `intent: LaunchIntent` parameter on `createOutputParser` (coordination change on #425 PR, not a breaking change since Wave 1 hasn't shipped).
- Register the plugin with `AgentLauncher` at orchestrator boot — explicit import + `registry.register()`, no dynamic discovery.

## Acceptance criteria

- Unit tests for `ClaudeCodeLaunchPlugin.buildLaunch()` with snapshot assertions on composed `{command, args, env}` for all three intents.
- Snapshot fixtures match the current direct-spawn behavior of cli-spawner / pr-feedback-handler / conversation-spawner. Use the Wave 1 snapshot harness to capture "before" values from the still-live direct spawn paths, then assert the plugin produces byte-identical output.
- Orchestrator boot registers the plugin; a sanity test verifies `agentLauncher.launch({ pluginId: "claude-code", ... })` routes to this plugin.
- All existing orchestrator tests pass unchanged — no caller migrated yet.

## Out of scope

- Deleting `PHASE_TO_COMMAND` and Claude flags from orchestrator internals (Wave 3 cleanup).
- Migrating `cli-spawner` / `pr-feedback-handler` / `conversation-spawner` callers (Wave 3).
- Migrating the root-level `claude-code-invoker.ts` (Wave 4).
- Changes to the existing `ClaudeCodePlugin` (Latency container-managed path).

## Dependencies

- Depends on Wave 1 Agent Launcher issue (types + registry).
- Depends on Wave 1 Snapshot Harness issue.
- Blocks Wave 3 (Claude spawn migrations) and Wave 4 (root-level consolidation).
- Parallel-safe with the other Wave 2 issues.

## References

- Parent tracking: #423


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
