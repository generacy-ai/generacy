# Quickstart: Migrate cli-spawner shell validators to AgentLauncher

## Development Setup

```bash
cd /workspaces/generacy
pnpm install
```

## Running Tests

### All orchestrator tests
```bash
pnpm --filter orchestrator test
```

### CLI spawner tests only
```bash
pnpm --filter orchestrator test -- --testPathPattern cli-spawner
```

### Launcher tests (reference)
```bash
pnpm --filter orchestrator test -- --testPathPattern agent-launcher
pnpm --filter orchestrator test -- --testPathPattern generic-subprocess
```

### Update snapshots after migration
```bash
pnpm --filter orchestrator test -- --testPathPattern cli-spawner --update
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/orchestrator/src/worker/cli-spawner.ts` | Migration target — modify constructor + 2 methods |
| `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts` | Update test setup, add snapshots |
| `packages/orchestrator/src/launcher/agent-launcher.ts` | AgentLauncher API (read-only) |
| `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts` | Shell intent plugin (read-only) |
| `packages/orchestrator/src/launcher/types.ts` | Type definitions (read-only) |

## Verification Checklist

1. Existing `runValidatePhase` tests pass unchanged
2. Existing `runPreValidateInstall` tests pass unchanged (including 5-min timeout test)
3. Snapshot tests confirm byte-identical `sh -c` command composition
4. No direct `processFactory.spawn('sh', ...)` calls remain for validator sites

## Troubleshooting

### Snapshot mismatch
If snapshot tests fail, check that env merging produces identical results. The 3-layer merge (`process.env` → plugin env → request env) with empty/undefined plugin and request env should equal `process.env` only.

### Mock wiring
When updating tests, ensure the mock `AgentLauncher` returns a `LaunchHandle` whose `.process` is the same mock `ChildProcessHandle` used by existing tests.
