# Quickstart: Verifying the per-host workers feature

**Issue**: [#716](https://github.com/generacy-ai/generacy/issues/716)
**Branch**: `716-problem-today-worker-count`

## Prerequisites

- Node.js >= 22 (the CLI gates on this).
- Docker + Docker Compose v2.
- `pnpm install` at the repo root.
- A test claim code from a cloud dashboard, OR `GENERACY_LAUNCH_STUB=1` for offline verification.

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
pnpm --filter @generacy-ai/activation-client build
pnpm --filter @generacy-ai/orchestrator build
```

## Run the unit tests

```bash
pnpm --filter @generacy-ai/generacy test -- worker-count-resolver
pnpm --filter @generacy-ai/generacy test -- scaffolder
pnpm --filter @generacy-ai/activation-client test -- client
pnpm --filter @generacy-ai/orchestrator test -- activation
```

Expected: all green. Key new assertions:
- `resolveWorkerCount` correctly chooses flag / prompt / default per Q3+Q4+Q5 matrix.
- `pollDeviceCode` body carries `workers` when provided; omits it when undefined.
- `scaffoldDockerCompose` output contains `GENERACY_INITIAL_WORKERS=${WORKER_COUNT}`.
- `scaffoldEnvFile` writes the supplied workers value into the `WORKER_COUNT=…` line.

## Manual verification — happy path (interactive)

```bash
cd /tmp
rm -rf demo-716

# Run launch with stubbed cloud (replace --claim with a real code if you have one).
GENERACY_LAUNCH_STUB=1 node /workspaces/generacy/packages/generacy/bin/generacy.js launch \
  --claim=claim_stub --dir=/tmp/demo-716
```

When prompted:

```
How many workers should run on this host? (1–8)
  ▸ 2          (default highlighted)
```

Enter `4` and confirm.

### Expected post-conditions

```bash
cd /tmp/demo-716

# 1. .env reflects choice
grep ^WORKER_COUNT= .generacy/.env
# → WORKER_COUNT=4

# 2. docker-compose.yml exposes GENERACY_INITIAL_WORKERS to orchestrator
grep -A1 'orchestrator:' .generacy/docker-compose.yml | grep GENERACY_INITIAL_WORKERS
# → - GENERACY_INITIAL_WORKERS=${WORKER_COUNT}

# 3. cluster.yaml carries the chosen value (until cloud companion #696 lands)
grep workers .generacy/cluster.yaml
# → workers: 4
```

### Compose interpolation check (no real launch needed)

```bash
docker compose --project-directory .generacy config | grep GENERACY_INITIAL_WORKERS
# → GENERACY_INITIAL_WORKERS: "4"
```

The interpolation from `${WORKER_COUNT}` → literal `"4"` proves the indirection works.

## Manual verification — `--workers` flag (non-interactive)

```bash
cd /tmp
rm -rf demo-716-flag

GENERACY_LAUNCH_STUB=1 node /workspaces/generacy/packages/generacy/bin/generacy.js launch \
  --claim=claim_stub --dir=/tmp/demo-716-flag --workers=3

grep ^WORKER_COUNT= /tmp/demo-716-flag/.generacy/.env
# → WORKER_COUNT=3
```

No prompt should appear; scaffolding proceeds directly.

## Manual verification — tier cap rejection

```bash
GENERACY_LAUNCH_STUB=1 node /workspaces/generacy/packages/generacy/bin/generacy.js launch \
  --claim=claim_stub --dir=/tmp/demo-716-cap --workers=100
```

Expected stderr:

```
--workers=100 exceeds tier cap of 8 (CLI fallback cap; real cap will be available
after the cloud companion ships).
```

Process exits non-zero. No `.generacy/` directory created.

## Manual verification — no TTY (Q5)

Simulate a non-TTY launch:

```bash
GENERACY_LAUNCH_STUB=1 node /workspaces/generacy/packages/generacy/bin/generacy.js launch \
  --claim=claim_stub --dir=/tmp/demo-716-notty < /dev/null
```

Expected warning before scaffolding:

```
No TTY detected and --workers not provided. Defaulting to 2 workers.
For reproducible scripted launches, pass --workers=2 explicitly.
```

`.env` should contain `WORKER_COUNT=2`. Exit code is 0.

## Manual verification — tier-cap fallback warning (Q3)

`GENERACY_LAUNCH_STUB=1` returns a fixture without `tierCap`, so the fallback path is the default for any stub-mode launch.

```bash
GENERACY_LAUNCH_STUB=1 node /workspaces/generacy/packages/generacy/bin/generacy.js launch \
  --claim=claim_stub --dir=/tmp/demo-716-fallback < /dev/null 2>&1 | grep fallback
# → tierCap fallback (8) in use because launch-config did not include tierCap. Update once cloud companion lands.
```

## End-to-end (requires real cloud, companion repos)

This is the full loop — only fully verifiable once the cluster-base entrypoint companion and the generacy-cloud companion (#696) both land.

```bash
cd ~/Generacy
node /workspaces/generacy/packages/generacy/bin/generacy.js launch --claim=<real-claim> --workers=4

# Wait for orchestrator boot, then exec inside the container:
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml exec orchestrator \
  cat /workspaces/<project>/.generacy/cluster.local.yaml
# → workers: 4
```

Then check the cloud cluster doc:

```bash
node /workspaces/generacy/packages/generacy/bin/generacy.js open --cluster=<id>
```

In the dashboard's cluster view, `targetWorkers` should read `4`. Subsequent `metadata.workers` heartbeats (from #714's enumeration) report the actual running container count.

## Troubleshooting

**Symptom**: `WORKER_COUNT=1` in `.env` after running `launch --workers=4`.

Check:
1. Is the build current? `pnpm --filter @generacy-ai/generacy build` and verify dist mtime.
2. Is the resolved value being threaded into `scaffoldProject(dir, config, workers)`? Add a `console.log(resolution)` after `resolveWorkerCount` to confirm.

**Symptom**: `docker compose up` complains about an undefined `${WORKER_COUNT}`.

Check that `.generacy/.env` exists with the `WORKER_COUNT=…` line. The compose file's interpolation reads from `.env` in the same directory; if `.env` is missing or the line was stripped, compose falls back to the `${WORKER_COUNT:-1}` default on `worker.deploy.replicas` but the orchestrator env will be undefined.

**Symptom**: Orchestrator container starts but `cluster.local.yaml` doesn't appear.

The entrypoint change is in the `cluster-base` companion PR. If that hasn't landed yet, the env var is exposed but no consumer reads it. Verify the image is the post-companion build:

```bash
docker exec <orch-container> cat /var/lib/generacy/SHA  # or equivalent build tag
```

**Symptom**: Tier-cap rejection on a real cloud despite legitimate tier.

The CLI may be running with stale launch-config schema. Confirm:

```bash
GENERACY_LAUNCH_STUB=1 ... 2>&1 | grep tierCap
```

If the warning line appears (`fallback (8) in use`), the cloud isn't yet sending `tierCap` — once the companion ships, the warning disappears and the cap raises to the real value. Use `--workers=8` as a stopgap.
