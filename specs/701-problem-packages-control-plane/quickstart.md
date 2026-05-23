# Quickstart: Fix #701

## What Changed

One function (`atomicWrite`) in `packages/control-plane/src/services/worker-scaler.ts`, line 176-180.

## Verify

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/control-plane test
```

## Files Modified

1. `packages/control-plane/src/services/worker-scaler.ts` — fix temp file location
2. `packages/control-plane/__tests__/services/worker-scaler.test.ts` — add same-filesystem assertion
