# Feature Specification: Migrate conversation-spawner to AgentLauncher (PTY wrapper)

**Branch**: `433-goal-phase-3c-spawn` | **Date**: 2026-04-12 | **Status**: Draft | **Issue**: #433

## Summary

Route interactive conversation turns through `AgentLauncher` + `ClaudeCodeLaunchPlugin` by migrating `ConversationSpawner.spawnTurn()` away from direct `python3 -u -c <PTY_WRAPPER> claude ...` invocation. This is Wave 3 Phase 3c of the spawn refactor — the highest-risk migration because the PTY wrapper subprocess shape (buffering, CRLF stripping, stdin piping) is easy to regress.

## Context

Today `ConversationSpawner` directly constructs the `python3` + PTY wrapper command and calls `conversationProcessFactory.spawn(...)`. The `AgentLauncher` + `ClaudeCodeLaunchPlugin` already know how to build the identical command via `buildConversationTurnLaunch()` and select the correct stdio profile (`'interactive'` → `conversationProcessFactory`). This issue flips the caller so all Claude process spawning flows through a single, plugin-based launcher.

### Current Flow (pre-migration)
```
ConversationManager.runTurn()
  → ConversationSpawner.spawnTurn()
    → processFactory.spawn('python3', ['-u', '-c', PTY_WRAPPER, 'claude', ...args])
```

### Target Flow (post-migration)
```
ConversationManager.runTurn()
  → ConversationSpawner.spawnTurn()
    → agentLauncher.launch({
        intent: { kind: 'conversation-turn', message, sessionId, model, skipPermissions },
        cwd, env, signal
      })
    → ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()
    → processFactory.spawn(...)  // via stdio profile routing
```

## User Stories

### US1: Consolidate spawn paths for maintainability

**As a** platform engineer maintaining the orchestrator,
**I want** all Claude CLI invocations to route through `AgentLauncher`,
**So that** there is a single place to modify command construction, environment merging, and process lifecycle — reducing the risk of spawn-site drift.

**Acceptance Criteria**:
- [ ] `ConversationSpawner.spawnTurn()` delegates to `AgentLauncher.launch()` instead of calling `processFactory.spawn()` directly
- [ ] The PTY wrapper script content is owned solely by `ClaudeCodeLaunchPlugin` (no duplicate in `conversation-spawner.ts`)
- [ ] All existing conversation tests pass without modification

### US2: Preserve byte-identical subprocess shape

**As a** developer working on the conversation system,
**I want** the migrated spawn to produce a byte-identical process invocation,
**So that** PTY buffering, CRLF stripping, stdin piping, and stdout streaming continue to work exactly as before.

**Acceptance Criteria**:
- [ ] Snapshot test confirms command + args + PTY wrapper content match the pre-refactor baseline
- [ ] Integration test verifies stdin writing and stdout streaming through the PTY wrapper
- [ ] Signal handling (SIGTERM → SIGKILL graceful shutdown) works unchanged

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `ConversationSpawner` accepts an `AgentLauncher` instance (injected via constructor or method) | P1 | Replaces direct `processFactory` usage for `spawnTurn()` |
| FR-002 | `spawnTurn()` constructs a `ConversationTurnIntent` from its options and calls `agentLauncher.launch()` | P1 | Intent fields: `message`, `sessionId?`, `model?`, `skipPermissions` |
| FR-003 | The returned `LaunchHandle.process` is used as the `ChildProcessHandle` for stdin/stdout/exit tracking | P1 | `ConversationManager.runTurn()` must continue to attach output parser and track exit |
| FR-004 | `conversationProcessFactory` is selected automatically via `stdioProfile: 'interactive'` in the `LaunchSpec` | P1 | Already implemented in `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` |
| FR-005 | The `PTY_WRAPPER` constant is removed from `conversation-spawner.ts` | P2 | Single source of truth in `ClaudeCodeLaunchPlugin` |
| FR-006 | `gracefulKill()` continues to work on the process handle returned by the launcher | P1 | No changes to kill logic expected |
| FR-007 | `cwd` and `env` are passed through the `LaunchRequest`, not constructed separately | P2 | Leverage launcher's 3-layer env merge |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Snapshot parity | Byte-identical command + args + PTY wrapper content | Snapshot test comparing composed spawn output |
| SC-002 | Existing test pass rate | 100% | All `conversation-spawner.test.ts` and `conversation-integration.test.ts` tests pass |
| SC-003 | New integration coverage | PTY wrapper invocation + stdin + stdout verified | Integration test with mock binary |
| SC-004 | No spawn-site duplication | `PTY_WRAPPER` exists only in `ClaudeCodeLaunchPlugin` | Code search confirms single definition |

## Assumptions

- `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` already produces the correct command shape (verified by its own snapshot tests in Wave 2)
- `AgentLauncher` stdio profile routing (`'interactive'` → `conversationProcessFactory`) is already wired in `server.ts`
- The `ConversationManager` does not need changes — it interacts with `ConversationSpawner` which continues to return `ConversationProcessHandle`

## Out of Scope

- Changes to the PTY wrapper script logic itself
- Other orchestrator spawn sites (phase runner, PR feedback)
- Modifying `ClaudeCodeLaunchPlugin` internals
- Full output parser integration (deferred to later wave)

## Dependencies

- **Depends on**: Wave 2 Claude Plugin issue (PTY wrapper already in `ClaudeCodeLaunchPlugin`)
- **Parallel-safe with**: Other Wave 3 issues (phase runner, PR feedback migrations)

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| PTY buffering regression | Conversation output silently lost or garbled | Snapshot test on full command including embedded Python script |
| stdin pipe not available | Conversation turns fail to send messages | Integration test verifies stdin writing through launcher path |
| Environment merge changes behavior | Claude CLI receives different env vars | Compare env snapshot pre/post migration |
| `gracefulKill` incompatible with launcher handle | Zombie processes on conversation end | Verify kill signal propagation in integration test |

## References

- Parent tracking: #423
- [Spawn refactor plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites)

---

*Generated by speckit*
