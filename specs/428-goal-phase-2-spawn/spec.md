# Feature Specification: Create ClaudeCodeLaunchPlugin

Extract Claude Code spawn logic into a dedicated `AgentLaunchPlugin` implementation.

**Branch**: `428-goal-phase-2-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Phase 2 of the [spawn refactor](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-2--extract-claudecodelaunchplugin). Create `ClaudeCodeLaunchPlugin` inside `@generacy-ai/generacy-plugin-claude-code` that implements the `AgentLaunchPlugin` interface from Wave 1. After this lands, `AgentLauncher` can handle `pluginId: "claude-code"` for phase execution, PR feedback, and interactive conversation intents — but no caller uses it yet (Wave 3 flips the callers).

## User Stories

### US1: Plugin-based phase execution

**As a** workflow orchestrator,
**I want** to launch Claude Code phase commands (specify, clarify, plan, tasks, implement) through the `AgentLauncher` plugin system,
**So that** spawn configuration is encapsulated in the plugin rather than scattered across orchestrator internals.

**Acceptance Criteria**:
- [ ] `buildLaunch({ kind: "phase", phase: "implement" })` produces the correct `claude /implement --output-format stream-json --dangerously-skip-permissions` command
- [ ] Resume flag (`--resume <sessionId>`) is included when `sessionId` is provided
- [ ] Snapshot output matches current `cli-spawner` behavior byte-for-byte

### US2: Plugin-based PR feedback

**As a** PR review pipeline,
**I want** to launch Claude Code PR feedback through the plugin system,
**So that** PR-specific CLI flags and prompt piping are owned by the plugin.

**Acceptance Criteria**:
- [ ] `buildLaunch({ kind: "pr-feedback", prNumber: 42 })` produces the correct `claude -p --output-format stream-json` command with PR context
- [ ] Snapshot output matches current `pr-feedback-handler` behavior

### US3: Plugin-based interactive conversation

**As a** conversation session manager,
**I want** to launch Claude Code interactive sessions through the plugin system with PTY wrapping,
**So that** the PTY wrapper script and interactive stdio configuration are owned by the plugin.

**Acceptance Criteria**:
- [ ] `buildLaunch({ kind: "conversation-turn", turn })` produces the correct `python3 -u -c <PTY_WRAPPER> claude ...` command
- [ ] PTY wrapper script matches the one currently in `conversation-spawner.ts`
- [ ] Snapshot output matches current `conversation-spawner` behavior
- [ ] Stdio profile is set to `interactive` (all pipes open)

## Scope

- Create `ClaudeCodeLaunchPlugin` inside [packages/generacy-plugin-claude-code](https://github.com/generacy-ai/generacy/tree/develop/packages/generacy-plugin-claude-code). The package continues to export `ClaudeCodePlugin` (Latency `AbstractDevAgentPlugin` base, container-managed) and adds the new launch plugin as a sibling export.
- Implement the `AgentLaunchPlugin` interface from Wave 1. Copy the following into the plugin WITHOUT deleting from orchestrator internals (Wave 3 cleanup does the deletion):
  - `PHASE_TO_COMMAND` map from [packages/orchestrator/src/worker/types.ts:73-80](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/worker/types.ts#L73-L80)
  - Claude CLI flags: `--resume`, `--output-format stream-json`, `--dangerously-skip-permissions`
  - PTY wrapper Python script currently embedded in [packages/orchestrator/src/conversation/conversation-spawner.ts:47-57](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/conversation/conversation-spawner.ts#L47-L57)
- Implement `buildLaunch(intent)` for each supported intent:
  - `{ kind: "phase", phase, sessionId? }` → `claude <phase-command>` + resume flags if sessionId provided
  - `{ kind: "pr-feedback", prNumber }` → `claude -p --output-format stream-json` with PR context
  - `{ kind: "conversation-turn", turn }` → `python3 -u -c <PTY_WRAPPER> claude ...` with interactive stdio
- Implement `createOutputParser()` returning the appropriate parser (stream-json for phase / pr-feedback, PTY output parser for conversation-turn).
- Register the plugin with `AgentLauncher` at orchestrator boot in `claude-cli-worker.ts` — explicit import + `agentLauncher.registerPlugin()`, no dynamic discovery.
- Add new LaunchIntent variants (`PhaseIntent`, `PrFeedbackIntent`, `ConversationTurnIntent`) to the discriminated union in `packages/orchestrator/src/launcher/types.ts`.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `ClaudeCodeLaunchPlugin` implements `AgentLaunchPlugin` interface with `pluginId: "claude-code"` | P1 | |
| FR-002 | `supportedKinds` returns `["phase", "pr-feedback", "conversation-turn"]` | P1 | |
| FR-003 | `buildLaunch` for `phase` intent composes `claude <slash-command> --output-format stream-json --dangerously-skip-permissions` | P1 | Uses copied `PHASE_TO_COMMAND` map |
| FR-004 | `buildLaunch` for `phase` intent with `sessionId` adds `--resume <sessionId>` flag | P1 | |
| FR-005 | `buildLaunch` for `pr-feedback` intent composes `claude -p --output-format stream-json` | P1 | |
| FR-006 | `buildLaunch` for `conversation-turn` intent wraps command in PTY wrapper via `python3 -u -c <script>` | P1 | Stdio profile: `interactive` |
| FR-007 | `createOutputParser` returns stream-json parser for phase/pr-feedback, PTY parser for conversation-turn | P1 | |
| FR-008 | Plugin is registered at orchestrator boot in `claude-cli-worker.ts` | P1 | Explicit import, no discovery |
| FR-009 | New `LaunchIntent` variants added to discriminated union type | P1 | `PhaseIntent`, `PrFeedbackIntent`, `ConversationTurnIntent` |

## Acceptance Criteria

- Unit tests for `ClaudeCodeLaunchPlugin.buildLaunch()` with snapshot assertions on composed `{command, args, env}` for all three intents.
- Snapshot fixtures match the current direct-spawn behavior of cli-spawner / pr-feedback-handler / conversation-spawner. Use the Wave 1 snapshot harness to capture "before" values from the still-live direct spawn paths, then assert the plugin produces byte-identical output.
- Orchestrator boot registers the plugin; a sanity test verifies `agentLauncher.launch({ pluginId: "claude-code", ... })` routes to this plugin.
- All existing orchestrator tests pass unchanged — no caller migrated yet.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Snapshot parity | 100% byte-identical | Wave 1 snapshot harness comparison against live spawn paths |
| SC-002 | Existing test suite | 0 regressions | All orchestrator tests pass unchanged |
| SC-003 | Plugin routing | Functional | Sanity test confirms `pluginId: "claude-code"` routes correctly |

## Assumptions

- Wave 1 `AgentLauncher`, `AgentLaunchPlugin` interface, and snapshot harness are merged and available on `develop`.
- The `LaunchIntent` discriminated union in `types.ts` is extensible (new variants can be added without breaking existing plugins).
- The PTY wrapper script does not need modification — it is copied as-is from `conversation-spawner.ts`.
- `ClaudeCodeLaunchPlugin` is a pure function of its inputs — no injected dependencies, no container management.

## Out of Scope

- Deleting `PHASE_TO_COMMAND` and Claude flags from orchestrator internals (Wave 3 cleanup).
- Migrating `cli-spawner` / `pr-feedback-handler` / `conversation-spawner` callers (Wave 3).
- Migrating the root-level `claude-code-invoker.ts` (Wave 4).
- Changes to the existing `ClaudeCodePlugin` (Latency container-managed path).

## Dependencies

- Depends on Wave 1 Agent Launcher issue (#425 — types + registry).
- Depends on Wave 1 Snapshot Harness issue (#427).
- Blocks Wave 3 (Claude spawn migrations) and Wave 4 (root-level consolidation).
- Parallel-safe with the other Wave 2 issues.

## Key Files

| File | Role |
|------|------|
| `packages/generacy-plugin-claude-code/src/` | New `ClaudeCodeLaunchPlugin` lives here as sibling to existing `ClaudeCodePlugin` |
| `packages/orchestrator/src/launcher/types.ts` | Add `PhaseIntent`, `PrFeedbackIntent`, `ConversationTurnIntent` to `LaunchIntent` union |
| `packages/orchestrator/src/launcher/agent-launcher.ts` | Plugin registry — no changes needed, plugin self-registers |
| `packages/orchestrator/src/worker/types.ts:73-80` | Source of `PHASE_TO_COMMAND` map (copy, don't delete) |
| `packages/orchestrator/src/conversation/conversation-spawner.ts:47-57` | Source of PTY wrapper script (copy, don't delete) |
| `packages/orchestrator/src/worker/claude-cli-worker.ts:106-113` | Registration site — add `registerPlugin(new ClaudeCodeLaunchPlugin())` |

## References

- Parent tracking: [#423](https://github.com/generacy-ai/generacy/issues/423)
- Spawn refactor plan: [spawn-refactor-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md)
- Wave 1 spec: [specs/425-goal-phase-1-spawn/](../425-goal-phase-1-spawn/)
- Snapshot harness: [specs/427-goal-add-spawn-snapshot/](../427-goal-add-spawn-snapshot/)

---

*Generated by speckit*
