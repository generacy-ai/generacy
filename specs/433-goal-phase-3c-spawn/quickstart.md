# Quickstart: Migrate conversation-spawner to AgentLauncher

**Feature**: #433 | **Branch**: `433-goal-phase-3c-spawn`

## Prerequisites

- Wave 2 Claude Plugin issue complete (`ClaudeCodeLaunchPlugin` with `conversation-turn` support)
- pnpm installed, dependencies up to date

## Setup

```bash
git checkout 433-goal-phase-3c-spawn
pnpm install
```

## Running Tests

```bash
# All orchestrator tests
pnpm test --filter @generacy-ai/orchestrator

# Conversation spawner tests specifically
pnpm test --filter @generacy-ai/orchestrator -- conversation-spawner

# Plugin tests (verify conversation-turn LaunchSpec)
pnpm test --filter @generacy-ai/generacy-plugin-claude-code

# Full test suite
pnpm test
```

## Key Files to Modify

| File | Change |
|------|--------|
| `packages/orchestrator/src/launcher/launcher-setup.ts` | NEW — shared `createAgentLauncher()` |
| `packages/orchestrator/src/conversation/conversation-spawner.ts` | Replace `processFactory` with `agentLauncher` |
| `packages/orchestrator/src/conversation/process-factory.ts` | Remove `process.env` double-merge |
| `packages/orchestrator/src/server.ts` | Wire `createAgentLauncher()` to spawner |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Use `createAgentLauncher()` |
| `packages/orchestrator/src/conversation/__tests__/conversation-spawner.test.ts` | Update mocks |

## Verification Checklist

- [ ] `pnpm test` passes (all packages)
- [ ] Snapshot test confirms byte-identical spawn command
- [ ] `conversation-manager.test.ts` unchanged and passing
- [ ] Integration test verifies PTY wrapper invocation + stdin/stdout streaming
- [ ] No remaining `processFactory` references in `conversation-spawner.ts`
- [ ] `PTY_WRAPPER` constant removed from `conversation-spawner.ts` (lives in plugin only)

## Troubleshooting

**Tests fail with "Unknown intent kind"**: Ensure `createAgentLauncher()` registers both `GenericSubprocessPlugin` and `ClaudeCodeLaunchPlugin`.

**Env vars missing in spawned process**: Verify `conversationProcessFactory` passes `options.env` through unchanged (not re-merging `process.env`). AgentLauncher handles the base layer merge.

**Snapshot mismatch**: Compare `ClaudeCodeLaunchPlugin`'s `PTY_WRAPPER` constant against the pre-refactor version in git history. They must be byte-identical.
