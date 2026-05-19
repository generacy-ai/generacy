# Quickstart: Phase 4b — executeCommand / executeShellCommand Migration

## Prerequisites

- Wave 1 completed (#425 AgentLauncher + GenericSubprocessPlugin, #427 snapshot testing)
- Node.js 20+, pnpm

## Development Setup

```bash
pnpm install
```

## Running Tests

### Workflow-engine tests (must all pass unchanged)

```bash
pnpm --filter @generacy-ai/workflow-engine test
```

### Orchestrator tests (snapshot tests)

```bash
pnpm --filter @generacy-ai/orchestrator test
```

### Update snapshots after intentional changes

```bash
pnpm --filter @generacy-ai/workflow-engine test -- --update
pnpm --filter @generacy-ai/orchestrator test -- --update
```

## Verification Checklist

1. **Public API unchanged**: `CommandOptions`, `CommandResult`, `executeCommand`, `executeShellCommand` signatures identical
2. **Existing tests pass**: `cli-utils.test.ts` — all streaming callback and UTF-8 tests green
3. **Snapshot tests pass**: New `cli-utils-snapshot.test.ts` captures correct spawn composition
4. **Process-group semantics**: Timeout and abort tests still kill entire process group via `process.kill(-pid, 'SIGTERM')`
5. **Fallback works**: When no launcher registered, direct `child_process.spawn` behavior preserved

## Key Files

| File | Action | Purpose |
|------|--------|---------|
| `packages/workflow-engine/src/actions/process-launcher.ts` | NEW | `LaunchFunction` type + registration API |
| `packages/workflow-engine/src/actions/cli-utils.ts` | MODIFY | Use registered launcher, fallback to direct spawn |
| `packages/orchestrator/src/worker/types.ts` | MODIFY | Add `detached` to `ProcessFactory.spawn` options |
| `packages/orchestrator/src/launcher/types.ts` | MODIFY | Add `detached` to `LaunchSpec`, intents |
| `packages/orchestrator/src/launcher/agent-launcher.ts` | MODIFY | Pass `detached` through to factory |
| `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts` | MODIFY | Forward `detached` from intent |

## Troubleshooting

### Snapshot mismatch after migration

Expected — the spawn composition changes from direct `child_process.spawn` args to `AgentLauncher` args. Review the diff carefully, then update snapshots.

### Process-group kill test failures

Check that:
1. `detached: true` is set in the `LaunchFunctionRequest`
2. The `ProcessFactory` implementation passes `detached` to `child_process.spawn`
3. The wrapper still calls `process.kill(-handle.pid, 'SIGTERM')` (not `handle.kill()`)

### External consumer regression

If `executeCommand` behaves differently without registration: verify the fallback path matches the original `child_process.spawn` call exactly (same options: `stdio`, `detached`, `env` merge).
