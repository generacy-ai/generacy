# Quickstart: Extend ProcessFactory with uid/gid

## Development

```bash
# Install dependencies
pnpm install

# Run orchestrator tests
cd packages/orchestrator
pnpm test

# Run specific test files
pnpm test -- --grep "uid"
pnpm test -- src/__tests__/worker/claude-cli-worker.test.ts
```

## Verification

After implementation, verify:

1. **All existing tests pass** (no regressions):
   ```bash
   cd packages/orchestrator && pnpm test
   ```

2. **New tests pass** (uid/gid forwarding):
   ```bash
   pnpm test -- --grep "uid\|gid"
   ```

3. **No callers modified**:
   ```bash
   git diff --stat | grep -v types.ts | grep -v process-factory.ts | grep -v claude-cli-worker.ts | grep -v test
   ```

## Files Modified

| File | Change |
|------|--------|
| `packages/orchestrator/src/worker/types.ts` | Add `uid?: number`, `gid?: number` to options |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Forward uid/gid in `defaultProcessFactory` |
| `packages/orchestrator/src/conversation/process-factory.ts` | Forward uid/gid in `conversationProcessFactory` |
| Test file(s) | New unit tests for uid/gid pass-through |

## Troubleshooting

- **TypeScript errors in callers**: Should not happen — fields are optional. If they do, check that the interface change is additive only.
- **Tests fail on Windows CI**: `uid`/`gid` are Unix-only; Node.js silently ignores them on Windows. Tests should mock `child_process.spawn` to avoid platform issues.
