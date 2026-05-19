# Quickstart: Testing #518 Schema Reconciliation

## Setup

```bash
cd /workspaces/generacy
pnpm install
```

## Running Tests

```bash
# Run all tests in the generacy CLI package
pnpm --filter @generacy-ai/generacy test

# Run only tests related to launch/deploy scaffolding
pnpm --filter @generacy-ai/generacy test -- --grep "scaffol"

# Run with coverage
pnpm --filter @generacy-ai/generacy test -- --coverage
```

## Manual Verification

### Verify cluster.json round-trip

After implementing, create a test scaffold and verify lifecycle commands can read it:

```bash
# 1. Launch with stub mode (no real cloud call)
GENERACY_LAUNCH_STUB=1 npx generacy launch --claim=test-code --dir=/tmp/test-cluster

# 2. Inspect written files
cat /tmp/test-cluster/.generacy/cluster.json
# Should show: cluster_id, project_id, org_id, cloud_url (snake_case, no camelCase)

cat /tmp/test-cluster/.generacy/cluster.yaml
# Should show: channel, workers, variant (no imageTag, cloudUrl, ports)

# 3. Verify lifecycle can read it
cd /tmp/test-cluster
npx generacy status
# Should NOT show "Cluster configuration is corrupted"
```

### Verify registry round-trip

```bash
# After launch, check registry
cat ~/.generacy/clusters.json | jq .
# Each entry should have variant: "cluster-base" or "cluster-microservices"
# Each entry should pass RegistryEntrySchema validation
```

### Verify Node version gate

```bash
# The launch command should reject Node < 22
# Check by inspecting the validateNodeVersion function
node -e "console.log(process.versions.node)"
# Must be >= 22
```

## Key Files to Review

| File | What to check |
|------|---------------|
| `commands/cluster/context.ts` | `activated_at` is optional; variant enum updated |
| `commands/cluster/registry.ts` | variant enum updated |
| `commands/cluster/scaffolder.ts` | NEW shared scaffolder writes snake_case cluster.json |
| `commands/launch/scaffolder.ts` | Delegates to shared scaffolder |
| `commands/launch/types.ts` | `orgId` added; local types removed |
| `commands/launch/registry.ts` | Uses shared `RegistryEntrySchema` |
| `commands/launch/index.ts` | Node check `>= 22`; registry uses shared schema |
| `commands/deploy/scaffolder.ts` | Delegates to shared scaffolder |
| `commands/deploy/index.ts` | Registry uses correct variant enum |

## Troubleshooting

**"Cannot find module './scaffolder.js'"** — Rebuild the package: `pnpm --filter @generacy-ai/generacy build`

**Zod validation still failing** — Check that `cluster.json` uses snake_case keys. Run: `node -e "const z = require('zod'); ..."` to test schema parsing manually.

**Registry parse error** — Delete `~/.generacy/clusters.json` (may contain entries with old `standard`/`microservices` enum values) and re-run launch.
