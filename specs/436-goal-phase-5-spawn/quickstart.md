# Quickstart: Phase 5 — Consolidate root-level claude-code-invoker

## Prerequisites

- Node.js 20+
- pnpm workspace linked (`pnpm install` from repo root)
- Phases 1-4 of spawn refactor merged (branches `425-*`, `433-*`, `429-*`, `430-*`)

## Development

### Install dependencies

After adding `@generacy-ai/orchestrator` to root `package.json`:

```bash
pnpm install
```

### Build

```bash
pnpm build
```

### Run tests

```bash
# Plugin tests (invoke intent)
pnpm --filter @generacy-ai/generacy-plugin-claude-code test

# Adapter tests (ClaudeCodeInvoker)
pnpm vitest run tests/agents/claude-code-invoker.test.ts

# Worker handler tests
pnpm vitest run tests/worker/handlers/agent-handler.test.ts

# All tests
pnpm test
```

## Verification Checklist

### Acceptance criteria verification

```bash
# AC1: No child_process in src/agents/
grep -rn "child_process" src/agents/
# Expected: no output

# AC2: AgentInvoker interface unchanged
git diff develop -- src/agents/types.ts
# Expected: no changes

# AC3: Plugin tests cover spawn-argv assertions
pnpm --filter @generacy-ai/generacy-plugin-claude-code test -- --reporter=verbose 2>&1 | grep "invoke"
# Expected: passing tests for invoke intent argv

# AC4: Adapter tests pass
pnpm vitest run tests/agents/claude-code-invoker.test.ts
# Expected: all pass
```

### Manual smoke test

```bash
# Start worker with new path
source /workspaces/tetrad-development/scripts/stack-env.sh
pnpm dev
# Worker should initialize with "[worker] Agent registry initialized"
```

## Troubleshooting

### "Unknown intent kind: invoke"
The `ClaudeCodeLaunchPlugin` hasn't been updated to handle the `invoke` kind. Verify that `supportedKinds` includes `'invoke'` and the switch statement has the new case.

### Import errors for @generacy-ai/orchestrator
Verify the workspace dependency is in root `package.json` and run `pnpm install` to link it.

### "Cannot find module" for process factory exports
Check that `packages/orchestrator/src/index.ts` exports the process factory types. They should be available via `@generacy-ai/orchestrator`.

### Tests fail with "launch is not a function"
Ensure the mock `AgentLauncher` in tests has a `launch` method that returns a valid `LaunchHandle` shape with `process`, `outputParser`, and `metadata`.
