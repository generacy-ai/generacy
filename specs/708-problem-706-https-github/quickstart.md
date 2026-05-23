# Quickstart — Verifying #708

Local steps to verify the fix end-to-end after implementation. Each step maps to a success criterion in the spec.

## Prerequisites

- A running Generacy cluster locally (created via `npx generacy launch ...` or `generacy init`), with at least one worker container.
- `docker` / `docker compose` v2 available on the host.
- Access to the cloud UI (or a way to POST to the orchestrator's scale lifecycle action — see SC-002 below).
- `.generacy/` exists in your project dir and contains `cluster.yaml`, `.env`, `docker-compose.yml`.

## Verify SC-001 — Cloud-UI scale survives `npx generacy update`

```bash
# 1. Start from a clean baseline.
cd /path/to/your/project
docker compose --project-name=<id> --file=.generacy/docker-compose.yml ps | grep worker
# expect: 1 worker container

grep WORKER_COUNT .generacy/.env
# expect: WORKER_COUNT=1

grep workers .generacy/cluster.yaml
# expect: workers: 1

# 2. Scale to 5 via the cloud UI (or trigger scaleWorkers directly).
#    [Cloud UI: open dashboard → cluster → click + four times]

# 3. Confirm both files updated.
grep WORKER_COUNT .generacy/.env
# expect: WORKER_COUNT=5

grep workers .generacy/cluster.yaml
# expect: workers: 5

# 4. Run update.
npx generacy update

# 5. Confirm worker count survived.
docker compose --project-name=<id> --file=.generacy/docker-compose.yml ps | grep worker | wc -l
# expect: 5
```

**Pass criterion**: 5 worker containers remain after `npx generacy update`.

## Verify SC-002 — Cloud-UI scale survives raw `docker compose up -d`

Same prep as SC-001, but step 4 replaced with:

```bash
docker compose --project-name=<id> --file=.generacy/docker-compose.yml up -d
```

**Pass criterion**: 5 worker containers remain. (This path does NOT call the deriver — survival depends entirely on layer 1, the worker-scaler `.env` write.)

## Verify SC-003 — Hand-edited `cluster.yaml` overrides stale `.env`

```bash
# 1. Start from a 5-worker scaled state (see SC-001 steps 1-3).

# 2. Hand-edit cluster.yaml down to 3.
sed -i 's/workers: 5/workers: 3/' .generacy/cluster.yaml

# 3. Confirm .env is now stale.
grep WORKER_COUNT .generacy/.env
# expect: WORKER_COUNT=5  (stale)

# 4. Run up.
npx generacy up

# 5. Confirm both files agree and compose ran 3 replicas.
grep WORKER_COUNT .generacy/.env
# expect: WORKER_COUNT=3

docker compose --project-name=<id> --file=.generacy/docker-compose.yml ps | grep worker | wc -l
# expect: 3
```

**Pass criterion**: 3 worker containers, `.env` reconciled to `WORKER_COUNT=3`.

## Verify SC-004 — `.env` and `cluster.yaml` agree after every `scaleWorkers` call

This is the programmatic test in `packages/control-plane/__tests__/services/worker-scaler.test.ts`. Run:

```bash
cd packages/control-plane
pnpm test worker-scaler
```

**Pass criterion**: All `.env`-sync test cases pass, including the new ones added in this PR (see research.md §D8).

## Verify FR-009 — `workers: 0` clamps to 1

```bash
# 1. Hand-edit cluster.yaml to an invalid zero.
sed -i 's/workers: .*/workers: 0/' .generacy/cluster.yaml

# 2. Run up.
npx generacy up
# expect log line: "cluster.yaml has workers: 0; clamping to 1"

# 3. Confirm self-heal.
grep workers .generacy/cluster.yaml
# expect: workers: 1
grep WORKER_COUNT .generacy/.env
# expect: WORKER_COUNT=1

docker compose --project-name=<id> --file=.generacy/docker-compose.yml ps | grep worker | wc -l
# expect: 1
```

## Verify FR-010 — Malformed `workers` value defaults to 1

```bash
# 1. Hand-edit cluster.yaml to an invalid string.
sed -i 's/workers: .*/workers: "five"/' .generacy/cluster.yaml

# 2. Run up.
npx generacy up
# expect log line: 'cluster.yaml workers field is malformed (got: "five"); using default 1'

# 3. Confirm self-heal.
grep workers .generacy/cluster.yaml
# expect: workers: 1
```

## Verify FR-008 — Missing `.env` is skip-and-warn (worker-scaler)

```bash
# 1. From a 1-worker state, delete .env.
rm .generacy/.env

# 2. Trigger a scale via cloud UI (or scaleWorkers API).
#    Scale to 3.

# 3. Inspect logs from the orchestrator container.
docker compose --project-name=<id> --file=.generacy/docker-compose.yml logs orchestrator | grep WORKER_COUNT
# expect: "WORKER_COUNT sync to .env skipped: file not found at .../.generacy/.env"

# 4. Confirm cluster.yaml still updated (source of truth wins).
grep workers .generacy/cluster.yaml
# expect: workers: 3

# 5. Verify the scale operation itself succeeded (3 worker containers running).
docker compose --project-name=<id> --file=.generacy/docker-compose.yml ps | grep worker | wc -l
# expect: 3
```

**Pass criterion**: No new `.env` created; cluster.yaml updated; scale succeeded.

## Unit-test run (full)

```bash
# From repo root:
pnpm test --filter @generacy-ai/control-plane worker-scaler
pnpm test --filter @generacy-ai/generacy worker-count-deriver
pnpm test --filter @generacy-ai/generacy "commands/up"
pnpm test --filter @generacy-ai/generacy "commands/update"
```

All four suites should pass with the new test cases enumerated in research.md §D8.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Worker count drops to 1 after `npx generacy update` | `.env` write in `worker-scaler.ts` did not happen (layer 1 broken) | Check orchestrator logs for `WORKER_COUNT sync` warnings; check `worker-scaler.test.ts` env-sync cases pass. |
| `npx generacy up` fails with Zod parse error mentioning `workers` | `cluster.yaml` has an invalid `workers` value and the deriver did NOT run before `getClusterContext()` | Verify `reconcileWorkerCount` is called *before* `getClusterContext()` in `up/index.ts` (or that `getClusterContext` is now resilient to clamped/defaulted yaml). |
| `.env` modifications lose other lines (e.g. `REPO_URL` disappears) | Writer is doing full re-emit instead of regex replace | Confirm the regex `/^WORKER_COUNT=.*$/m` is being used and the replace preserves untouched lines. Run the in-place replace test case. |
| Cluster.yaml self-heal corrupts other fields (e.g. `channel`, `appConfig`) | YAML re-emit is not preserving full document | Confirm the rewrite reads the full doc, mutates only the `workers` key, then re-stringifies with `yaml.stringify`. |
| Warnings spam every `npx generacy up` even with valid `cluster.yaml` | Deriver mis-classifies positive integers | Re-run the `workers: 5` deriver test; should produce `source: 'cluster.yaml'` with empty `warnings`. |

## Roll-back

If the fix introduces a regression in production:

```bash
git revert <commit-sha>
```

There is no schema migration or persisted state to roll back — both `.env` and `cluster.yaml` were already part of the steady-state contract, and the `WORKER_COUNT` line revert simply means `.env` returns to whatever value it had before. The next `docker compose up -d` will read that value verbatim.
