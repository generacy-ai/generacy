# Quickstart: Remove hardcoded 999 cap in createFeature()

## Testing

```bash
# Run the specific test file
cd /workspaces/generacy
pnpm --filter workflow-engine test -- src/actions/builtin/speckit/lib/__tests__/feature.test.ts

# Run all workflow-engine tests
pnpm --filter workflow-engine test
```

## Verification

After the fix, confirm:

1. **Cap removed**: `createFeature({ number: 1004, description: 'test' })` returns `success: true`
2. **Padding correct**: `feature_num` for 1004 is `'1004'` (not truncated or zero-padded)
3. **Branch name correct**: Branch for 1004 is `1004-short-name` format
4. **Error fields populated**: All `success: false` returns include a non-empty `error` string

## Files Changed

| File | Change |
|------|--------|
| `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` | Remove `> 999` guard, add error strings |
| `packages/workflow-engine/src/actions/builtin/speckit/types.ts` | Update JSDoc |
| `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts` | Add >= 1000 tests |
