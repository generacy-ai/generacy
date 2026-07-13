# Quickstart: Orchestrator boot-time service resume

**Feature**: `824-summary-after-cluster-stopped` | **Date**: 2026-07-07

Reproduce the bug, validate the fix, and confirm regression coverage. Commands assume a live local cluster reachable via `generacy` CLI; on-cluster diagnostics run inside the orchestrator container.

## Reproduce the bug (pre-fix, on `develop`)

Requires an already-bootstrapped local cluster (activated + `bootstrap-complete` has previously run).

```bash
# From /workspaces/generacy
git checkout develop
pnpm install
pnpm --filter @generacy-ai/orchestrator build

# Confirm the tunnel is running on your live cluster (project page shows connected).
generacy status                 # cluster is up

# Stop then start the cluster:
generacy stop
generacy up

# Wait ~30 s for orchestrator boot.
# Inside the orchestrator container:
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml exec orchestrator ps -ef | grep 'code tunnel'
# → NO output. The tunnel process is missing.

# Project page in the cloud shows the tunnel disconnected.
# https://vscode.dev/tunnel/<tunnel-name> stops resolving.
```

**Expected in bug state**: no `code tunnel` process, no `code-server` process, tunnel URL 404s.

## Validate the fix

Switch to this feature branch:

```bash
git checkout 824-summary-after-cluster-stopped
pnpm install
pnpm --filter @generacy-ai/orchestrator build

# Rebuild the cluster image if you run it as a container:
# (For local dev: hot-reload picks up the change once the orchestrator container restarts.)
generacy update
```

### Case 1 — clean stop/start cycle (primary use case)

```bash
generacy stop
generacy up

# Wait 15–30 s.
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml exec orchestrator ps -ef | grep 'code tunnel'
# → shows the `code tunnel --name <tunnel-name> ...` process.

# Cloud project page shows the tunnel connected within ~30 s.
# https://vscode.dev/tunnel/<tunnel-name> resolves.
```

**SC-001 target**: <60 s from `generacy up` command completion to tunnel restored. Measure with:

```bash
STOP_TS=$(date +%s)
generacy up
# ... wait until vscode.dev URL responds 200 ...
UP_TS=$(date +%s)
echo "Restore latency: $((UP_TS - STOP_TS))s"
# → expect < 60 s.
```

### Case 2 — orchestrator container restart (subset of Case 1)

Restarting only the orchestrator container (leaving the cluster's other containers up) should have the same outcome.

```bash
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml restart orchestrator

# Wait ~30 s.
# Expect tunnel + code-server both running inside orchestrator.
```

### Case 3 — control-plane down at orchestrator boot (failure surface)

Simulate control-plane unavailability by pausing its container before orchestrator restart:

```bash
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml pause control-plane
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml restart orchestrator

# Wait 20 s.
# On the cloud dashboard: expect two cluster.bootstrap events:
#   { status: 'failed', reason: 'resume-failed', service: 'vscode-tunnel', error: 'Control-plane socket did not become ready' }
#   { status: 'failed', reason: 'resume-failed', service: 'code-server',   error: 'Control-plane socket did not become ready' }

# Unpause and manually recover via UI Restart button.
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml unpause control-plane
```

### Case 4 — first-boot path is unchanged (regression guard)

```bash
# Provision a fresh cluster from scratch:
generacy launch --claim=<code>
# → wizard, activation, bootstrap-complete, tunnel starts as it always has.
# No resume-service invocation on first boot because postActivationComplete
# transitions false→true DURING first bootstrap-complete, not before it.
```

Inside the orchestrator container after first-boot completes, the log line `Boot resume: control-plane not yet ready` should NOT appear on a healthy first-boot. It only appears on subsequent restarts.

### Case 5 — one service fails, the other succeeds (regression guard for SC-003)

Requires injecting a controlled failure — most easily done in a unit test (see `packages/orchestrator/src/__tests__/boot-resume-service.test.ts`). Manual repro is racy; skip in favor of the automated test.

## Test suite

```bash
pnpm --filter @generacy-ai/orchestrator test src/__tests__/boot-resume-service.test.ts
pnpm --filter @generacy-ai/orchestrator test src/__tests__/post-activation-retry.test.ts
```

The sibling test should still pass — this feature does not touch `PostActivationRetryService`.

Full orchestrator test suite:

```bash
pnpm --filter @generacy-ai/orchestrator test
```

## Success criteria checks

**SC-001**: Restart-to-tunnel-restored latency < 60 s.

Automation is a manual timing check per Case 1. Alternative: inspect orchestrator logs for the `Boot resume: both lifecycle actions dispatched` info line and confirm it appears within 15 s of process start.

**SC-002**: `generacy stop` → `generacy start` cycles leave the VS Code tunnel offline in 0% of runs.

Cross-check by running 3 stop/start cycles back-to-back and confirming `code tunnel` is running each time:

```bash
for i in 1 2 3; do
  echo "=== cycle $i ==="
  generacy stop
  sleep 2
  generacy up
  sleep 20
  docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml exec orchestrator ps -ef | grep -c 'code tunnel'
  # → expect 1 each iteration.
done
```

**SC-003**: `generacy stop` → `generacy start` cycles leave code-server unreachable in 0% of runs.

Same loop as SC-002, but check `code-server`:

```bash
for i in 1 2 3; do
  echo "=== cycle $i ==="
  generacy stop
  sleep 2
  generacy up
  sleep 20
  # Probe via orchestrator /health — expects codeServerReady: true.
  docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml exec orchestrator \
    curl -s http://localhost:3100/health | grep -o '"codeServerReady":[a-z]*'
  # → expect "codeServerReady":true each iteration.
done
```

**SC-004**: Boot-resume failures reach the operator via `cluster.bootstrap` events.

Manual: run Case 3 above. On the cloud project page, expect the two failure events to appear in the activity feed. If they don't, the relay-event wiring is broken.

## Troubleshooting

**Tunnel process still missing after `generacy up`** — Check orchestrator logs:

```bash
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml logs orchestrator | grep -i 'resume\|boot resume\|lifecycle'
```

If you see `Boot resume: control-plane not yet ready`, the control-plane container is slow to boot. Extend `controlPlaneWaitTimeout` (env var TBD if introduced later) or check control-plane container health.

If you see `Boot resume: lifecycle-action-failed` with a 5xx error, inspect control-plane logs — the tunnel or code-server manager itself failed. Fix upstream, then use UI Restart or manually POST the missing lifecycle action:

```bash
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml exec orchestrator \
  curl -X POST --unix-socket /run/generacy-control-plane/control.sock \
  -H 'Content-Type: application/json' \
  -H 'x-generacy-actor-user-id: system' \
  -H 'x-generacy-actor-session-id: manual-recovery' \
  http://localhost/lifecycle/vscode-tunnel-start
```

**Both services started on first boot AND on restart — is that a double-start?** No. On first boot, `postActivationComplete === false` (the sentinel doesn't exist yet), so `needsRetry === true`, the sibling `PostActivationRetryService` fires `bootstrap-complete`, and the new resume service is skipped. On subsequent restarts, `postActivationComplete === true`, so the sibling retry is skipped and the resume service fires. Mutually exclusive branches (see `data-model.md` §Call graph delta).

**"Restart" button in the cloud UI does nothing on my cluster** — Unrelated companion bug (#604 device-code race orphans the tunnel child). Not fixed by this feature.

**Two `cluster.bootstrap` failure events appear even though only one service is broken** — Look at the `service` field. Only the failing service should emit; the succeeding one is silent. If both emit despite one succeeding, that's a bug — file it and reference `data-model.md` §Invariants (I1).
