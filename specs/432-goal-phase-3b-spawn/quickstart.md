# Quickstart: #432 — Migrate pr-feedback-handler to AgentLauncher

## Prerequisites

- Node.js and pnpm installed
- Dependencies installed: `pnpm install`
- Wave 2 plugin (#428) merged (ClaudeCodeLaunchPlugin supports `pr-feedback` intent)

## Files to Modify

1. `packages/orchestrator/src/worker/pr-feedback-handler.ts` — Add AgentLauncher param, swap spawn call
2. `packages/orchestrator/src/worker/claude-cli-worker.ts` — Pass agentLauncher to PrFeedbackHandler
3. `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` — Update tests, add snapshot

## Running Tests

```bash
# Run PR feedback handler tests
pnpm --filter orchestrator test -- pr-feedback-handler

# Run all orchestrator tests
pnpm --filter orchestrator test

# Run snapshot tests specifically
pnpm --filter orchestrator test -- cli-spawner-snapshot
```

## Validation Steps

1. **Unit tests pass**: All existing `pr-feedback-handler.test.ts` tests pass without modification
2. **Snapshot parity**: New snapshot test confirms byte-identical spawn args between direct and launcher paths
3. **Type check**: `pnpm --filter orchestrator typecheck` passes

## Troubleshooting

### Tests fail with "AgentLauncher is not a constructor"
Ensure the import path is correct: `import { AgentLauncher } from '../launcher/agent-launcher';`

### Snapshot mismatch
The snapshot harness sorts env keys. If env differences appear, check that the `env: {}` caller argument is being passed correctly (no extra keys).

### "Plugin not found for intent kind: pr-feedback"
Ensure `ClaudeCodeLaunchPlugin` is registered on the `AgentLauncher` instance before launching. Check `claude-cli-worker.ts` constructor.

### Signal handling test failures
`LaunchHandle.process` exposes the same `kill()` method. If signal tests fail, verify that `handle.process` (not `handle`) is being used for `kill()` calls.
