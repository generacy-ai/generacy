# Feature Specification: Migrate conversation-spawner to AgentLauncher (PTY wrapper)

**Issue**: [#433](https://github.com/generacy-ai/generacy/issues/433) | **Branch**: `433-goal-phase-3c-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Route interactive conversation turns through `AgentLauncher` + `ClaudeCodeLaunchPlugin` instead of directly calling `processFactory.spawn()` in `ConversationSpawner`. This is Phase 3c of the spawn refactor — the highest-risk Wave 3 issue because the PTY wrapper subprocess shape is easy to regress.

## Goal

Phase 3c of the [spawn refactor](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites). Consolidate all Claude CLI subprocess spawning behind the `AgentLauncher` abstraction so that spawn logic (command construction, PTY wrapper embedding, env merging) is owned by plugins rather than scattered across callers.

## Scope

- Migrate `ConversationSpawner.spawnTurn()` ([conversation-spawner.ts:99](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/conversation/conversation-spawner.ts#L99)) from direct `processFactory.spawn('python3', ['-u', '-c', PTY_WRAPPER, ...claudeArgs], ...)` to `agentLauncher.launch({ intent: { kind: 'conversation-turn', ... }, cwd, env })`.
- The PTY wrapper script already lives in `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` (Wave 2). This issue flips the caller.
- `AgentLauncher` selects `conversationProcessFactory` (interactive stdio `['pipe', 'pipe', 'pipe']`) via the `stdioProfile: 'interactive'` returned by `ClaudeCodeLaunchPlugin`.
- Preserve signal handling, turn lifecycle, stdin piping, stdout parsing, and abort propagation exactly.

## User Stories

### US1: Conversation Turn Spawning via AgentLauncher

**As a** platform maintainer,
**I want** ConversationSpawner to delegate spawn construction to AgentLauncher + ClaudeCodeLaunchPlugin,
**So that** all Claude CLI spawn logic is centralized in plugins, reducing duplication and making the PTY wrapper shape testable in one place.

**Acceptance Criteria**:
- [ ] `ConversationSpawner` accepts an `AgentLauncher` instance instead of (or in addition to) a raw `ProcessFactory`
- [ ] `spawnTurn()` calls `agentLauncher.launch()` with a `ConversationTurnIntent` instead of directly building the python3/PTY_WRAPPER command
- [ ] The spawned subprocess is byte-identical to the pre-refactor baseline (same command, args, PTY wrapper content, env)
- [ ] All existing conversation-spawner and conversation-manager tests pass (mock setup may change, assertions must remain equivalent)
- [ ] `gracefulKill()` continues to work via `LaunchHandle.process.kill()`

### US2: Snapshot Verification of Spawn Shape

**As a** developer working on the spawn refactor,
**I want** a snapshot test that captures the exact subprocess shape for a conversation turn,
**So that** regressions in command construction, PTY wrapper content, or argument ordering are caught immediately.

**Acceptance Criteria**:
- [ ] Snapshot test captures command, args (including full PTY wrapper script), cwd, and env keys
- [ ] Snapshot is byte-identical to pre-refactor baseline
- [ ] Test fails if PTY wrapper content, argument order, or env shape changes

### US3: Integration Verification with Mock Binary

**As a** developer,
**I want** an integration test that exercises the full spawn path with a mock binary,
**So that** stdin writing, stdout streaming, and PTY wrapper invocation are verified end-to-end.

**Acceptance Criteria**:
- [ ] Integration test spawns via AgentLauncher with a mock binary
- [ ] Verifies stdin is piped to the process
- [ ] Verifies stdout streaming returns expected output
- [ ] Verifies the PTY wrapper is invoked with correct arguments

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `ConversationSpawner` accepts an `AgentLauncher` instance (injected via constructor or method) and uses it for `spawnTurn()` | P1 | Replaces direct `processFactory` usage for spawnTurn() |
| FR-002 | `spawnTurn()` constructs a `LaunchRequest` with `intent: { kind: 'conversation-turn', message, sessionId, model, skipPermissions }` | P1 | Maps existing `ConversationTurnOptions` fields to `ConversationTurnIntent` |
| FR-003 | `spawnTurn()` returns `ChildProcessHandle` (extracted from `LaunchHandle.process`) to maintain the existing API contract with `ConversationManager` | P1 | ConversationManager expects raw process handle |
| FR-004 | `AgentLauncher` routes `conversation-turn` intent to `ClaudeCodeLaunchPlugin`, which returns `LaunchSpec` with `stdioProfile: 'interactive'` | P1 | Ensures `conversationProcessFactory` (pipe/pipe/pipe) is selected |
| FR-005 | `gracefulKill()` operates on `LaunchHandle.process` identically to current `ChildProcessHandle` behavior (SIGTERM → grace period → SIGKILL) | P1 | No behavioral change to kill lifecycle |
| FR-006 | Stdin validation: `spawnTurn()` still throws if the spawned process has no stdin stream | P1 | Existing safety check must be preserved |
| FR-007 | `cwd` and `env` are passed through the `LaunchRequest`, not constructed separately by the spawner | P2 | AgentLauncher handles env merging (process.env ← plugin env ← caller env) |
| FR-008 | The deprecated `spawn()` method (legacy long-lived process) may retain direct `processFactory` usage or be removed if unused | P3 | Out of primary scope; assess during implementation |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Subprocess shape identity | Byte-identical command + args + PTY wrapper content | Snapshot test comparison against pre-refactor baseline |
| SC-002 | Existing test pass rate | 100% of conversation-spawner and conversation-manager tests pass | CI test suite |
| SC-003 | Integration coverage | stdin piping, stdout streaming, and PTY wrapper invocation verified | New integration test with mock binary |
| SC-004 | No ConversationManager changes | ConversationManager code is unmodified | Git diff shows zero changes to conversation-manager.ts |

## Assumptions

- `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` already produces the correct PTY wrapper command (delivered by Wave 2)
- `AgentLauncher` is already instantiated in `claude-cli-worker.ts` with both `default` and `interactive` process factories registered
- `ConversationManager` will continue to manage session state (`sessionId`) and output parsing independently of `AgentLauncher`
- The `conversationProcessFactory` env merging behavior (adding `process.env`) is compatible with `AgentLauncher`'s 3-layer env merge

## Out of Scope

- Changes to the PTY wrapper script logic itself
- Other orchestrator spawn sites (handled by separate Wave 3 issues)
- Adding new `AbortSignal` support beyond what currently exists
- Changes to `ConversationManager` or `ConversationOutputParser`
- Modifying `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` logic

## Dependencies

- **Depends on**: Wave 2 Claude Plugin issue (PTY wrapper already in `ClaudeCodeLaunchPlugin`)
- **Parallel-safe with**: Other Wave 3 issues (#430, #429)
- **Parent tracking**: [#423](https://github.com/generacy-ai/generacy/issues/423)

## Key Files

| File | Role |
|------|------|
| `packages/orchestrator/src/conversation/conversation-spawner.ts` | Primary file being modified — spawn delegation |
| `packages/orchestrator/src/launcher/agent-launcher.ts` | AgentLauncher class (plugin registry + launch orchestration) |
| `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` | Plugin providing `buildConversationTurnLaunch()` |
| `packages/orchestrator/src/conversation/process-factory.ts` | `conversationProcessFactory` (interactive stdio) |
| `packages/orchestrator/src/launcher/types.ts` | `LaunchRequest`, `LaunchSpec`, `LaunchHandle` types |
| `packages/generacy-plugin-claude-code/src/launch/types.ts` | `ConversationTurnIntent` type definition |
| `packages/orchestrator/src/conversation/conversation-manager.ts` | Consumer of `spawnTurn()` — should NOT change |
| `packages/orchestrator/src/server.ts` | Wiring: where `ConversationSpawner` is instantiated |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Wiring: where `AgentLauncher` is instantiated |

---

*Generated by speckit*
