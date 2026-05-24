# Quickstart: Verifying the CLI worker-count-deriver fix

**Issue**: [#712](https://github.com/generacy-ai/generacy/issues/712)
**Branch**: `712-problem-cli-s`

## Prerequisites

- Node.js >= 22 (the CLI gates on this).
- `pnpm install` at the repo root.
- A scratch project directory you can throw away (the verification scenarios mutate `.generacy/.env`).

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
```

## Run the unit tests

The fast feedback loop is the test file directly:

```bash
pnpm --filter @generacy-ai/generacy test -- worker-count-deriver
```

All 8 matrix rows from `data-model.md` are covered. The `cluster.yaml unchanged` assertions in the `reconcileWorkerCount` describe block are the key regression guards for acceptance criterion #2 (never write `cluster.yaml`).

## Manual verification — the regression scenario from the spec

This mirrors the bug described in `spec.md` lines 22–27.

### Setup

```bash
mkdir -p /tmp/g712-test/.generacy
cd /tmp/g712-test

# Canonical: template default of 1 worker.
cat > .generacy/cluster.yaml <<'EOF'
channel: stable
workers: 1
variant: cluster-base
EOF

# Overlay: cloud UI scaled to 5 workers (simulating worker-scaler.ts).
cat > .generacy/cluster.local.yaml <<'EOF'
workers: 5
EOF

# Stale .env from a prior up: WORKER_COUNT still at canonical 1.
cat > .generacy/.env <<'EOF'
GENERACY_CLUSTER_ID=test
WORKER_COUNT=1
EOF
```

### Run the deriver via the CLI

```bash
# `update` invokes reconcileWorkerCount.
node /workspaces/generacy/packages/generacy/bin/generacy.js update --dry-run \
  2>&1 | grep -E '(WORKER_COUNT|workers|cluster\.local)'
```

### Expected outcome

```bash
# .env now reflects the scaled value, not the template default.
grep ^WORKER_COUNT= .generacy/.env
# → WORKER_COUNT=5

# cluster.yaml is untouched.
git diff --no-index /dev/null .generacy/cluster.yaml  # baseline reference
# (canonical file should still show `workers: 1`)
```

A log line `Reconciled WORKER_COUNT from cluster.local.yaml: 5` should appear.

### Negative check (pre-fix behavior)

Before this fix, running the same scenario produced:

- `.env`: `WORKER_COUNT=1` ← **bug** (regressed to template default)
- `cluster.yaml`: rewritten (with malformed `workers` fallback paths) ← **bug** (#709 violation)

After the fix:

- `.env`: `WORKER_COUNT=5` ← correct (overlay wins)
- `cluster.yaml`: byte-identical ← correct

## Verification — degraded local overlay (Q1=C)

```bash
# Corrupt the overlay.
echo 'workers: not-a-number' > /tmp/g712-test/.generacy/cluster.local.yaml

node /workspaces/generacy/packages/generacy/bin/generacy.js update --dry-run 2>&1
```

Expected:

- Warning: `cluster.local.yaml unreadable; using cluster.yaml value`
- `.env` updated to `WORKER_COUNT=1` (canonical layer wins).
- Command exits 0 (does **not** fail — Q1 resolved C, not B).

## Verification — canonical missing, overlay valid (Q3=B)

```bash
rm /tmp/g712-test/.generacy/cluster.yaml
echo 'workers: 4' > /tmp/g712-test/.generacy/cluster.local.yaml

node /workspaces/generacy/packages/generacy/bin/generacy.js update --dry-run 2>&1
```

Expected:

- Warning: `cluster.yaml not found at <path>; using cluster.local.yaml value (workers: 4). Run 'npx generacy init' to restore the template config.`
- `.env`: `WORKER_COUNT=4`.
- Command exits 0.

## Available commands touched by this feature

| Command              | File                                                  | Effect                                              |
|----------------------|-------------------------------------------------------|-----------------------------------------------------|
| `npx generacy up`    | `packages/generacy/src/cli/commands/up/index.ts`      | Awaits `reconcileWorkerCount` before `docker compose up -d`. |
| `npx generacy update`| `packages/generacy/src/cli/commands/update/index.ts`  | Awaits `reconcileWorkerCount` before `docker compose pull && up -d`. |

No CLI flags added or changed.

## Troubleshooting

**Symptom**: `WORKER_COUNT` is still reset to `1` after running `update`.

Check:
1. Is `cluster.local.yaml` actually present in `.generacy/` and parseable? `cat .generacy/cluster.local.yaml`.
2. Does it pass the schema? `workers` must be a positive integer (`workers: 5`, not `workers: "5"`, not `workers: 0`).
3. Is there an old build of `@generacy-ai/generacy` on PATH? `which generacy` — should point at the local `pnpm` build.

**Symptom**: `cluster.yaml` shows up dirty in `git status` after `npx generacy up`.

This is the exact behavior #712 fixes. If it reproduces on this branch, the write-back branch in `reconcileWorkerCount` was not fully removed — re-check `worker-count-deriver.ts` for any `atomicWriteSync(yamlPath, …)` call.

**Symptom**: `npx generacy up` fails with `SyntaxError: Unexpected token` or similar.

The local overlay's YAML is malformed beyond what `readMergedClusterConfig` can recover from. Expected behavior: warning + fallback to canonical (exit 0). If this fails hard, the degraded-read try/catch is missing.
