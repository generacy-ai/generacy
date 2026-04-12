# Quickstart: Phase 3a — Migrate spawnPhase to AgentLauncher

## Prerequisites

- Wave 2 (`ClaudeCodeLaunchPlugin`) merged on `develop`
- Node.js, pnpm installed
- Branch: `431-goal-phase-3a-spawn`

## Development

```bash
# Install dependencies
pnpm install

# Run orchestrator tests (primary verification)
pnpm --filter orchestrator test

# Run just the cli-spawner tests
pnpm --filter orchestrator test -- cli-spawner

# Run snapshot tests only
pnpm --filter orchestrator test -- cli-spawner-snapshot

# Type check
pnpm --filter orchestrator typecheck

# Update snapshots after verifying diff is intentional
pnpm --filter orchestrator test -- cli-spawner-snapshot --update
```

## Key Files to Modify

| File | Change |
|------|--------|
| `packages/orchestrator/src/worker/cli-spawner.ts` | Add AgentLauncher to constructor, replace spawn logic in `spawnPhase()` |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Pass `this.agentLauncher` to CliSpawner constructor |
| `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts` | Update constructor wiring in `beforeEach` |
| `packages/orchestrator/src/worker/__tests__/cli-spawner-snapshot.test.ts` | Route through AgentLauncher path |

## Verification Checklist

- [ ] `pnpm --filter orchestrator test` — all tests pass
- [ ] `pnpm --filter orchestrator typecheck` — no type errors
- [ ] Snapshot diff shows args are byte-identical to pre-refactor
- [ ] `spawnPhase()` no longer directly calls `processFactory.spawn('claude', ...)`
- [ ] `spawnPhase()` does NOT pass `signal` to `agentLauncher.launch()`
- [ ] `runValidatePhase()` and `runPreValidateInstall()` still use `processFactory` directly

## Troubleshooting

**Snapshot test fails with env differences**
The AgentLauncher merges `process.env` into the spawn env. Check if `normalizeSpawnRecords()` strips env keys. If not, update it to normalize env for stable snapshots.

**Type error: 'validate' not assignable to PhaseIntent['phase']**
`spawnPhase()` accepts `WorkflowPhase` which includes `'validate'`. Narrow the type to `Exclude<WorkflowPhase, 'validate'>` or add a runtime guard before constructing the `PhaseIntent`.

**Double env merge concern**
`AgentLauncher` merges `process.env` into env, and `defaultProcessFactory` also does `{ ...process.env, ...options.env }`. This is safe — the factory merge is a no-op over an already-merged env (all keys already present).
