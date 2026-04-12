# Feature Specification: Phase 3c — Migrate conversation-spawner to AgentLauncher

**Issue**: [#433](https://github.com/generacy-ai/generacy/issues/433) | **Branch**: `433-goal-phase-3c-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

## Goal

Phase 3c of the [spawn refactor](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites). Route interactive conversation turns through `AgentLauncher` + `ClaudeCodeLaunchPlugin`. This is the highest-risk Wave 3 issue because the PTY wrapper subprocess shape is easy to regress.

## Scope

- Migrate [packages/orchestrator/src/conversation/conversation-spawner.ts:99](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/conversation/conversation-spawner.ts#L99) from direct `python3 -u -c <PTY_WRAPPER> claude ...` spawn to `agentLauncher.launch({ pluginId: "claude-code", intent: { kind: "conversation-turn", turn }, params, cwd, env, signal })`.
- The PTY wrapper script itself lives in `ClaudeCodeLaunchPlugin` (resolved open question #4; already copied there by the Wave 2 Claude Plugin issue). This issue just flips the caller.
- Continue to use `conversationProcessFactory` (interactive stdio `['pipe', 'pipe', 'pipe']`). The launcher should route to the correct `ProcessFactory` instance for this intent, or this issue should pass the factory in explicitly if that's the cleanest integration.
- Preserve signal handling, turn lifecycle, stdin piping, stdout parsing, and abort propagation exactly.

## Acceptance criteria

- Snapshot test on composed spawn for a conversation turn — byte-identical to pre-refactor baseline **including the embedded Python wrapper script content**.
- All existing conversation-spawner tests pass unchanged.
- Integration test with a mock binary verifying PTY wrapper invocation, stdin writing, and stdout streaming.

## Out of scope

- Changes to the PTY wrapper script logic itself.
- Other orchestrator spawn sites.

## Dependencies

- Depends on Wave 2 Claude Plugin issue.
- Parallel-safe with the other Wave 3 issues.

## References

- Parent tracking: #423


## User Stories

### US1: Conversation turn routing through AgentLauncher

**As a** platform developer,
**I want** conversation turns to be spawned via `AgentLauncher` + `ClaudeCodeLaunchPlugin` instead of direct `python3` PTY wrapper invocation,
**So that** all Claude spawn sites are consolidated behind the unified launcher abstraction, reducing duplication and making future spawn behavior changes single-point.

**Acceptance Criteria**:
- [ ] `conversation-spawner.ts` calls `agentLauncher.launch()` instead of directly composing the `python3 -u -c <PTY_WRAPPER> claude ...` command
- [ ] The PTY wrapper script content comes from `ClaudeCodeLaunchPlugin`, not from inline code in the spawner
- [ ] `conversationProcessFactory` (interactive stdio `['pipe', 'pipe', 'pipe']`) is still used for the spawned process
- [ ] Signal handling, turn lifecycle, stdin piping, stdout parsing, and abort propagation are preserved identically

### US2: Regression-safe migration with snapshot verification

**As a** platform developer,
**I want** snapshot tests proving the composed spawn command is byte-identical to the pre-refactor baseline,
**So that** the high-risk PTY wrapper subprocess shape cannot silently regress.

**Acceptance Criteria**:
- [ ] Snapshot test confirms the full spawn command (including embedded Python wrapper script) matches pre-refactor output
- [ ] All existing `conversation-spawner` tests pass unchanged
- [ ] Integration test with a mock binary verifies PTY wrapper invocation, stdin writing, and stdout streaming

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Replace direct `python3 -u -c <PTY_WRAPPER> claude ...` spawn at `conversation-spawner.ts:99` with `agentLauncher.launch({ pluginId: "claude-code", intent: { kind: "conversation-turn", turn }, params, cwd, env, signal })` | P1 | Core migration |
| FR-002 | PTY wrapper script must be sourced from `ClaudeCodeLaunchPlugin` (already placed there by Wave 2) | P1 | No script duplication |
| FR-003 | Continue using `conversationProcessFactory` with `['pipe', 'pipe', 'pipe']` stdio configuration | P1 | Interactive mode requirement |
| FR-004 | Preserve abort/signal propagation through the launcher to the spawned process | P1 | Critical for turn lifecycle |
| FR-005 | Launcher must route to the correct `ProcessFactory` for conversation-turn intents (or accept it explicitly) | P2 | Design decision needed during planning |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Spawn output parity | Byte-identical to pre-refactor baseline | Snapshot test comparison |
| SC-002 | Existing test suite | 100% pass rate, zero changes | CI green on all conversation-spawner tests |
| SC-003 | Integration coverage | PTY invocation + stdin/stdout streaming verified | Mock binary integration test |

## Assumptions

- Wave 2 Claude Plugin issue is complete — `ClaudeCodeLaunchPlugin` already contains the PTY wrapper script
- `AgentLauncher` API supports the `intent` shape needed for conversation turns
- `conversationProcessFactory` is already injectable / accessible from the launcher integration point

## Out of Scope

- Changes to the PTY wrapper script logic itself
- Other orchestrator spawn sites (those are separate Wave 3 issues)
- Changes to `AgentLauncher` core API (should work with existing interface)

---

*Generated by speckit*
