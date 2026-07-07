# Quickstart: Wire boot-resume into the wizard startup path (#834)

**Feature**: `834-summary-824-fix-auto` | **Date**: 2026-07-07

Reproduce the bug on a wizard-provisioned cluster, validate the fix, and confirm regression coverage. Commands assume a live local cluster reachable via `generacy` CLI; on-cluster diagnostics run inside the orchestrator container.

## Reproduce the bug (pre-fix, on `develop`)

Requires a **wizard-provisioned** cluster (i.e. one bootstrapped through the browser wizard, so the relay API key lands in `/var/lib/generacy/cluster-api-key` rather than the process env). Env-key clusters are unaffected by this bug — they correctly resume via #824.

```bash
# From /workspaces/generacy
git checkout develop
pnpm install
pnpm --filter @generacy-ai/orchestrator build

# Bootstrap a fresh cluster from the wizard (produces a wizard-provisioned cluster
# whose relay key persists to /var/lib/generacy/cluster-api-key):
generacy launch --claim=<code>
# → click through the wizard; wait for bootstrap-complete + tunnel connected.

# Confirm the tunnel is running on the fresh cluster:
generacy status                 # cluster is up

# Stop then start the cluster:
generacy stop
generacy up

# Wait ~30 s for orchestrator boot.
# Inside the orchestrator container, check for the code-tunnel process AND the
# boot-resume log line (added by #824, but not reached on the wizard path):
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml \
  exec orchestrator ps -ef | grep 'code tunnel'
# → NO output. The tunnel process is missing.

docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml \
  logs orchestrator | grep -i 'Boot resume'
# → NO output. `BootResumeService.triggerBootResume()` never fired.

# Confirm the branch we took by looking for activation markers:
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml \
  logs orchestrator | grep -E 'Existing cluster API key|Cluster activation complete'
# → both lines present → we took `activateInBackground()`, not the sync branch.

# Cloud project page shows the tunnel disconnected.
# https://vscode.dev/tunnel/<tunnel-name> stops resolving.
```

**Expected in bug state**: no `code tunnel` process, no `code-server` process, no `Boot resume:` log lines, tunnel URL 404s. #824 shipped a fix that never runs on this path.

## Validate the fix

Switch to this feature branch and rebuild:

```bash
git checkout 834-summary-824-fix-auto
pnpm install
pnpm --filter @generacy-ai/orchestrator build

# Rebuild the cluster image if you run it as a container:
generacy update
```

### Case 1 — wizard-provisioned cluster clean stop/start (primary use case)

```bash
generacy stop
generacy up

# Wait 15–30 s.
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml \
  exec orchestrator ps -ef | grep 'code tunnel'
# → shows the `code tunnel --name <tunnel-name> ...` process.

docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml \
  logs orchestrator | grep -i 'Boot resume'
# → shows the "Boot resume: waiting for control-plane socket" line and the
#   "Boot resume: both lifecycle actions dispatched" line.

# Cloud project page shows the tunnel connected within ~30 s.
# https://vscode.dev/tunnel/<tunnel-name> resolves.
```

**SC-001 target (inherited from #824)**: <60 s from `generacy up` completion to tunnel restored on a wizard-provisioned cluster. Measure with:

```bash
STOP_TS=$(date +%s)
generacy up
# ... wait until vscode.dev URL responds 200 ...
UP_TS=$(date +%s)
echo "Restore latency: $((UP_TS - STOP_TS))s"
# → expect < 60 s. Should match env-key cluster performance from #824.
```

### Case 2 — env-key cluster regression check (no behavior change expected)

Env-key clusters (rare in dev; more common in some CI setups) should continue to work exactly as they did on `develop` — this feature is purely a call-site consolidation for that branch.

```bash
# On a cluster whose relay key comes from env (usually via CLUSTER_API_KEY env var):
generacy stop
generacy up
# → tunnel restores in <60s, same as before.
```

### Case 3 — first-boot regression check (wizard path)

```bash
# Provision a fresh cluster from scratch on this branch:
generacy launch --claim=<code>
# → wizard, activation, bootstrap-complete, tunnel starts as it always has.
# On first boot the resume path is NOT taken because postActivationComplete
# transitions false→true DURING first bootstrap-complete, not before it.
# So the retry path fires (needsRetry === true), triggers bootstrap-complete,
# and both services come up via that path (unchanged from before).
```

Inside orchestrator logs after first-boot completes, the log line `Boot resume: waiting for control-plane socket` should NOT appear on the very first boot — only on subsequent restarts.

### Case 4 — needsRetry path preserved on wizard branch (regression guard for sibling behavior)

Requires stopping the cluster between activation and post-activation completion — hard to trigger manually. Automated coverage lives in `packages/orchestrator/src/__tests__/post-activation-retry.test.ts` (unchanged by this feature). No manual repro needed.

### Case 5 — control-plane down at orchestrator boot (failure surface, wizard branch)

Simulate control-plane unavailability by pausing its container before orchestrator restart on a wizard-provisioned cluster:

```bash
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml pause control-plane
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml restart orchestrator

# Wait 20 s.
# On the cloud dashboard: expect two cluster.bootstrap events (same shape as env-key branch under #824):
#   { status: 'failed', reason: 'resume-failed', service: 'vscode-tunnel', error: 'Control-plane socket did not become ready' }
#   { status: 'failed', reason: 'resume-failed', service: 'code-server',   error: 'Control-plane socket did not become ready' }

# Unpause and manually recover via UI Restart button.
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml unpause control-plane
```

Both branches (env-key and wizard) should surface identical failure events now — they both call the same helper, which constructs the same `BootResumeService`.

## Test suite

The load-bearing regression test:

```bash
pnpm --filter @generacy-ai/orchestrator test src/__tests__/server-boot-resume-wizard-branch.test.ts
```

The optional helper unit test:

```bash
pnpm --filter @generacy-ai/orchestrator test src/__tests__/post-activation-dispatch.test.ts
```

Sibling / adjacent suites (should all still pass — this feature does not touch them):

```bash
pnpm --filter @generacy-ai/orchestrator test src/__tests__/post-activation-retry.test.ts
pnpm --filter @generacy-ai/orchestrator test src/__tests__/boot-resume-service.test.ts
pnpm --filter @generacy-ai/orchestrator test src/__tests__/server-background-activation.test.ts
```

Full orchestrator test suite:

```bash
pnpm --filter @generacy-ai/orchestrator test
```

## Success criteria checks

**SC-002 (functional)**: On wizard-provisioned clusters, `generacy stop` → `generacy up` cycles restore the VS Code tunnel in 100% of runs. Cross-check by running 3 stop/start cycles back-to-back and confirming `code tunnel` is running each time:

```bash
for i in 1 2 3; do
  echo "=== cycle $i ==="
  generacy stop
  sleep 2
  generacy up
  sleep 20
  docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml \
    exec orchestrator ps -ef | grep -c 'code tunnel'
  # → expect 1 each iteration.
done
```

**SC-003 (test-level, load-bearing)**: The regression test at `server-boot-resume-wizard-branch.test.ts` fails if the boot-resume dispatch is removed from `runPostActivationBranch` OR from the wizard-branch call site in `server.ts`. Verify by:

```bash
# 1. Confirm the test passes on this branch:
pnpm --filter @generacy-ai/orchestrator test src/__tests__/server-boot-resume-wizard-branch.test.ts
# → PASS.

# 2. In a scratch working copy, comment out the resume branch inside
#    runPostActivationBranch:
#      /* if (state.activated && state.postActivationComplete) { ... } */
# Re-run:
pnpm --filter @generacy-ai/orchestrator test src/__tests__/server-boot-resume-wizard-branch.test.ts
# → FAIL. (Do NOT commit this; revert.)
```

If step 2 does not fail, the test is a false-positive and needs strengthening.

**SC-004 (inherited from #824)**: Wizard-branch boot-resume failures reach the operator via `cluster.bootstrap` events. Manual: run Case 5 above. On the cloud project page, expect the two failure events to appear in the activity feed. If they don't, the relay-event wiring is broken.

## Troubleshooting

**Tunnel process still missing after `generacy up` on wizard-provisioned cluster** — Check orchestrator logs for the boot-resume markers:

```bash
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml \
  logs orchestrator | grep -iE 'Boot resume|Post-activation'
```

If you see `Post-activation incomplete on restart — triggering retry`, the state check took the retry branch (probably because `/var/lib/generacy/post-activation-complete` is missing). The tunnel should still come up via `bootstrap-complete`; if it doesn't, this is a different bug — check `PostActivationRetryService` behavior.

If you see `Boot resume: waiting for control-plane socket` but no `Boot resume: both lifecycle actions dispatched`, the control-plane container is slow or down. Extend the wait timeout via `controlPlaneWaitTimeout` (currently not env-configurable — TBD in a follow-up) or check control-plane container health directly.

If you see **neither** log line after 30 s on a wizard-provisioned cluster, this feature's fix is not applied. Confirm you rebuilt with `pnpm --filter @generacy-ai/orchestrator build` and restarted the container.

**Env-key cluster behavior changed** — Should not happen; the env-key branch's semantics are preserved by the helper. If you observe divergence, compare the `runPostActivationBranch` invocation in the env-key branch (`server.ts:~470-503`) against the wizard branch (`server.ts:~879-896` inside `activateInBackground`). They MUST be identical modulo the `sendRelayEvent` source variable (`relayClientRef` vs `localRelayClient`).

**Test `server-boot-resume-wizard-branch.test.ts` passes but real cluster doesn't resume** — Almost certainly a wiring gap in `activateInBackground()` that the test's mock scaffolding doesn't exercise. Confirm the wizard-branch call site actually invokes `runPostActivationBranch(...)` after `initializeRelayBridge()` and after `detectIdentitySplit()`.

**"Restart" button in the cloud UI does nothing on my cluster** — Unrelated companion bug (#604 device-code race / #825 device-code-timeout hardening). Not fixed by this feature.

## Design decision recap

| Clarification | Answer | Concrete effect |
|---------------|--------|----------------|
| Q1 (helper shape) | A — helper owns the decision | `runPostActivationBranch` internally does retry / resume / noop; both call sites collapse to one line |
| Q2 (helper location) | A — new module | `packages/orchestrator/src/services/post-activation-dispatch.ts` |
| Q3 (test approach) | A load-bearing + C optional | Integration test on `createServer()` wizard-branch is required; helper unit test is a welcome complement |

See [research.md](./research.md) for rationale and alternatives.
