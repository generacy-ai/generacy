# Quickstart: Disambiguate `GENERACY_CLOUD_URL`

**Issue**: #549 | **Branch**: `549-problem-single-env-var`

## What Changed

The single `GENERACY_CLOUD_URL` env var is replaced by two purpose-specific vars:

| Old | New | Purpose |
|-----|-----|---------|
| `GENERACY_CLOUD_URL` (HTTP meaning) | `GENERACY_API_URL` | HTTP REST API calls |
| `GENERACY_CLOUD_URL` (WebSocket meaning) | `GENERACY_RELAY_URL` | WebSocket relay connection |

A third URL, `GENERACY_APP_URL` (dashboard), exists in `LaunchConfig.cloud` but is NOT written to the cluster `.env` (no consumer yet).

## Verification Steps

### 1. New cluster scaffolding uses new env vars

```bash
# Launch a new cluster (with stub mode for testing)
GENERACY_LAUNCH_STUB=1 npx generacy launch --claim=test --dir=/tmp/test-cluster

# Verify .env contains new var names
grep -E 'GENERACY_(API|RELAY)_URL' /tmp/test-cluster/.generacy/.env
# Expected:
#   GENERACY_API_URL=http://localhost:3000
#   GENERACY_RELAY_URL=ws://localhost:3000/relay?projectId=proj_stub001

# Verify old var is NOT present
grep 'GENERACY_CLOUD_URL' /tmp/test-cluster/.generacy/.env
# Expected: no output
```

### 2. Backward compatibility (old cloud without `cloud` object)

The code falls back to deriving URLs from `LaunchConfig.cloudUrl` when `cloud` is absent. Existing clusters using `GENERACY_CLOUD_URL` in their `.env` continue to work — readers check the old name as a fallback and log a deprecation message.

### 3. Deprecation log appears

```bash
# Set old var name
export GENERACY_CLOUD_URL=https://api-staging.generacy.ai
unset GENERACY_API_URL

# Run any CLI command that resolves cloud URL
npx generacy launch --claim=test 2>&1 | grep deprecated
# Expected: [deprecated] GENERACY_CLOUD_URL is ambiguous, prefer GENERACY_API_URL
```

### 4. Run tests

```bash
pnpm test --filter=@generacy-ai/generacy
pnpm test --filter=@generacy-ai/orchestrator
pnpm test --filter=@generacy-ai/cluster-relay
```

## Troubleshooting

**Q: My existing cluster stopped connecting after update**
A: Check `.generacy/.env` — if it still has `GENERACY_CLOUD_URL`, the orchestrator will fall back to it. No action needed. To silence the deprecation log, rename to `GENERACY_API_URL` and `GENERACY_RELAY_URL`.

**Q: The scaffolder writes wrong relay URL**
A: If the cloud hasn't been updated yet (no `LaunchConfig.cloud`), the scaffolder derives the relay URL from `cloudUrl` using `deriveRelayUrl()`. Verify the input `cloudUrl` is correct HTTP URL (e.g., `https://api-staging.generacy.ai`).

**Q: Registry shows old `cloudUrl` field name**
A: This is intentional. The registry field `cloudUrl` in `~/.generacy/clusters.json` is not renamed in this phase (it's persisted data). It stores the app/dashboard URL for `generacy open`.
