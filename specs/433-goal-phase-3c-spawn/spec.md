# Feature Specification: Migrate conversation-spawner to AgentLauncher (Phase 3c)

Phase 3c of the [spawn refactor](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites). Route interactive conversation turns through `AgentLauncher` + `ClaudeCodeLaunchPlugin`.

**Branch**: `433-goal-phase-3c-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Replace the direct `python3 -u -c <PTY_WRAPPER> claude ...` spawn in `ConversationSpawner.spawnTurn()` with a call through `AgentLauncher.launch()` using `ClaudeCodeLaunchPlugin`'s `conversation-turn` intent. This is the highest-risk Wave 3 issue because the PTY wrapper subprocess shape (Python PTY + CRLF stripping + line-buffered output) is easy to regress.

## Scope

- Migrate `packages/orchestrator/src/conversation/conversation-spawner.ts:99` from direct `this.processFactory.spawn('python3', ['-u', '-c', PTY_WRAPPER, ...claudeArgs], ...)` to `agentLauncher.launch({ intent: { kind: "conversation-turn", ... }, cwd, env, signal })`.
- The PTY wrapper script itself lives in `ClaudeCodeLaunchPlugin` (already copied there by the Wave 2 Claude Plugin issue). This issue just flips the caller.
- Continue to use `conversationProcessFactory` (interactive stdio `['pipe', 'pipe', 'pipe']`). The launcher routes to this factory via `stdioProfile: 'interactive'` in the `LaunchSpec`.
- Preserve signal handling, turn lifecycle, stdin piping, stdout parsing, and abort propagation exactly.

## Dependencies

- Depends on Wave 2 Claude Plugin issue (PTY wrapper already in `ClaudeCodeLaunchPlugin`).
- Parallel-safe with the other Wave 3 issues.
- Parent tracking: #423

## User Stories

### US1: Spawn Consolidation for Maintainability

**As a** platform engineer maintaining the orchestrator,
**I want** conversation-turn spawning to go through `AgentLauncher` instead of directly calling `processFactory.spawn()`,
**So that** all Claude CLI invocations flow through a single, plugin-based dispatch layer, reducing duplication and making spawn behavior auditable in one place.

**Acceptance Criteria**:
- [ ] `ConversationSpawner` no longer directly references `python3`, `PTY_WRAPPER`, or constructs Claude CLI args itself
- [ ] `ConversationSpawner` delegates to `AgentLauncher.launch()` with a `conversation-turn` intent
- [ ] The spawned process is byte-identical to the pre-refactor baseline (same command, args, env, stdio)

### US2: Behavioral Preservation for Interactive Conversations

**As a** user having a conversation with Claude via the Generacy UI,
**I want** the conversation turn subprocess to behave identically after the refactor,
**So that** streaming output, stdin piping, abort/signal handling, and session resumption continue working without regression.

**Acceptance Criteria**:
- [ ] PTY wrapper invocation is identical (Python unbuffered mode, CRLF stripping, 50000-column width)
- [ ] stdin piping for interactive conversation input works as before
- [ ] stdout streaming + JSON parsing pipeline is unaffected
- [ ] AbortSignal propagation kills the subprocess correctly
- [ ] Session resume (`--resume`) and model override (`--model`) flags pass through

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Inject `AgentLauncher` into `ConversationSpawner` (constructor or method param) | P1 | Currently uses `processFactory` directly |
| FR-002 | Replace direct `processFactory.spawn('python3', ...)` call with `agentLauncher.launch({ intent: { kind: 'conversation-turn', ... } })` | P1 | Core migration |
| FR-003 | Pass turn message, session ID, model, cwd, env, and signal through the `LaunchRequest` | P1 | All current params must flow through |
| FR-004 | `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` returns `stdioProfile: 'interactive'` to select `conversationProcessFactory` | P1 | Already implemented in plugin; verify |
| FR-005 | Remove `PTY_WRAPPER` constant and direct Claude arg construction from `conversation-spawner.ts` | P2 | Dedup — these now live in the plugin |
| FR-006 | Wire `LaunchHandle.process` (stdout, stderr, stdin, pid, kill, exitPromise) into existing turn lifecycle management | P1 | Must match `ChildProcessHandle` interface |
| FR-007 | Snapshot test: composed spawn args for conversation-turn are byte-identical to pre-refactor baseline | P1 | Including embedded Python wrapper script |
| FR-008 | Integration test: mock binary verifying PTY wrapper invocation, stdin write, stdout streaming | P1 | New test |
| FR-009 | All existing conversation-spawner tests pass unchanged | P1 | Regression gate |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Existing conversation-spawner tests | 100% pass | CI test suite |
| SC-002 | Snapshot test on composed spawn args | Byte-identical to baseline | Snapshot comparison including PTY wrapper content |
| SC-003 | Integration test coverage | PTY invocation + stdin + stdout verified | New mock-binary integration test |
| SC-004 | No direct spawn in conversation-spawner | 0 references to `processFactory.spawn` for conversation turns | Code review / grep |
| SC-005 | Interactive conversation regression | No user-visible behavior change | Manual E2E test of conversation turn |

## Assumptions

- Wave 2 Claude Plugin issue is complete: `ClaudeCodeLaunchPlugin` already has `buildConversationTurnLaunch()` with the PTY wrapper and correct arg construction.
- `AgentLauncher` is already instantiated in `ClaudeCliWorker` with both `default` and `interactive` `ProcessFactory` instances registered.
- The `LaunchHandle.process` interface is compatible with how `ConversationSpawner` currently consumes the `ChildProcessHandle`.

## Out of Scope

- Changes to the PTY wrapper script logic itself.
- Other orchestrator spawn sites (covered by sibling Wave 3 issues).
- Migrating the `OutputParser` / `OutputCapture` pipeline (future work).
- Changes to `conversationProcessFactory` stdio configuration.

## References

- [Spawn Refactor Plan — Phase 3](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites)
- Parent tracking: #423

---

*Generated by speckit*
