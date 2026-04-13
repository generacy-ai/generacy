# Quickstart: Fix pre-existing test failures in claude-cli-worker.test.ts

## Prerequisites

- Node.js and pnpm installed
- Repository cloned and dependencies installed (`pnpm install`)

## Verify the Problem

Run the orchestrator tests to see the 15 failures:

```bash
cd packages/orchestrator
pnpm test -- --reporter=verbose src/worker/__tests__/claude-cli-worker.test.ts
```

## Apply the Fix

In `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts`, line 24:

Change `has_changes: false` to `has_changes: true` in the initial `mockGithub.getStatus` declaration.

## Verify the Fix

```bash
# Run just the affected test file
pnpm test -- src/worker/__tests__/claude-cli-worker.test.ts

# Run all orchestrator tests to confirm no regressions
cd packages/orchestrator && pnpm test
```

Expected: 61/61 tests pass, 0 skips.

## Troubleshooting

**Tests still failing after the fix?**
- Ensure `pnpm install` has been run
- Check that you're on the correct branch: `git branch --show-current`
- Run with verbose output: `pnpm test -- --reporter=verbose`
