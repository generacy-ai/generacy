# Quickstart: Phase 4 Cleanup — Remove `GENERACY_CLOUD_URL` Fallback Chains

## Prerequisites

Before starting this work, verify:

1. Phases 1-3 of #549 have shipped and stabilized (at least one release cycle)
2. Cloud emits `LaunchConfig.cloud` object with split URLs
3. All active clusters scaffolded with new env var names

## Verification Commands

### Before starting — confirm no clusters depend on old var

```bash
# Check if any active cluster .env files still use GENERACY_CLOUD_URL
# (should return empty if Phase 3 cluster-base .env.template is deployed)
```

### After implementation — SC-001 validation

```bash
# Zero hits in src/ directories (excluding test negative assertions)
cd /workspaces/generacy
rg 'GENERACY_CLOUD_URL' packages/generacy/src/ packages/orchestrator/src/ packages/cluster-relay/src/

# Should return empty. If any hits remain, they need cleanup.
```

### Run tests

```bash
pnpm test
```

### End-to-end smoke test

```bash
# Fresh launch against staging (no GENERACY_CLOUD_URL in environment)
generacy launch --claim=<fresh-claim-code>

# Verify the --api-url flag works
generacy launch --claim=<code> --api-url https://api-staging.generacy.ai

# Verify --cloud-url shows deprecation warning
generacy launch --claim=<code> --cloud-url https://api-staging.generacy.ai
# Should print: [deprecated] --cloud-url is deprecated, use --api-url
```

## Implementation Checklist

1. Remove `GENERACY_CLOUD_URL` fallback from `cloud-url.ts`
2. Remove `resolveCloudUrl` deprecated export from `cloud-url.ts`
3. Remove `GENERACY_CLOUD_URL` fallbacks from `loader.ts` (both activation and relay)
4. Add fail-loud error in orchestrator when `GENERACY_API_URL` is missing
5. Update `relay.ts` comment
6. Update `cloud-client.ts` 404 error message
7. Rename `--cloud-url` to `--api-url` in `launch/index.ts` and `deploy/index.ts`
8. Add `--cloud-url` as hidden alias with deprecation warning
9. Update all test files
10. Run `rg GENERACY_CLOUD_URL` — verify zero source hits
11. File follow-up issue for `--cloud-url` alias removal
12. File companion issue in generacy-cloud for `LaunchConfig.cloudUrl` removal

## Troubleshooting

### Orchestrator fails to start after this change

The orchestrator now requires `GENERACY_API_URL` explicitly. Check the cluster's `.generacy/.env` file — it should contain `GENERACY_API_URL=https://...`. If missing, the cluster was scaffolded before Phase 2 (#549) shipped and needs re-launch.

### CLI breaks with "Invalid cloud URL"

If scripts pass `--cloud-url`, they'll still work (hidden alias) but see a deprecation warning. Update to `--api-url`.

### Tests fail on `GENERACY_CLOUD_URL` assertions

Tests now include negative assertions verifying the old var is NOT read. If a test sets `GENERACY_CLOUD_URL` and expects it to be used, that test needs updating to use `GENERACY_API_URL`.
