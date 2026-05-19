# Quickstart: #517 Activation cloud_url Fix

## Prerequisites

```bash
pnpm install
```

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `packages/activation-client/src/types.ts` | Add `cloud_url` to PollResponseSchema, add `cloudUrl?` to ActivationResult |
| 2 | `packages/orchestrator/src/activation/index.ts` | Persist `pollResult.cloud_url`, return `cloudUrl` in both paths |
| 3 | `packages/orchestrator/src/server.ts` | Override relay/activation config from `cloudUrl` |

## Verification

### Build

```bash
pnpm --filter @generacy-ai/activation-client build
pnpm --filter @generacy-ai/orchestrator build
```

### Run Tests

```bash
# Unit tests for activation-client
pnpm --filter @generacy-ai/activation-client test

# Unit tests for orchestrator activation
pnpm --filter @generacy-ai/orchestrator test -- --grep "activation"

# All tests
pnpm test
```

### Manual Verification

1. **Schema acceptance**: Create a test script that parses an approved response with `cloud_url`:
```typescript
import { PollResponseSchema } from '@generacy-ai/activation-client';

const response = {
  status: 'approved',
  cluster_api_key: 'key-123',
  cluster_api_key_id: 'kid-456',
  cluster_id: 'cls-789',
  project_id: 'prj-abc',
  org_id: 'org-def',
  cloud_url: 'https://custom.example.com',
};

const result = PollResponseSchema.parse(response);
console.log(result.cloud_url); // "https://custom.example.com"
```

2. **Cluster.json inspection**: After activation, check:
```bash
cat /var/lib/generacy/cluster.json | jq .cloud_url
# Should show the cloud-returned URL, not the default
```

3. **Boot-time override**: Check orchestrator logs for relay URL matching the custom cloud URL.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ZodError: invalid_union_discriminator` on activation | Old activation-client without `cloud_url` in schema | Rebuild activation-client package |
| `cluster.json` has default URL after activation | `index.ts` still using `cloudUrl` config input | Ensure line 83 uses `pollResult.cloud_url` |
| Relay connects to wrong URL after restart | `server.ts` not reading `cloudUrl` from activation result | Check FR-004 implementation in server.ts |
| Pre-fix clusters fail on boot | Missing `cloud_url` in old `cluster.json` | `cloudUrl` is optional — should gracefully skip override |
