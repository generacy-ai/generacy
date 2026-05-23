# Quickstart: Verifying Worker Scaling Against a Launched Cluster

**Issue**: [#706](https://github.com/generacy-ai/generacy/issues/706)
**Branch**: `706-problem-worker-scaler-ts`

This guide walks through manually exercising the rewritten `worker-scaler.ts` against a live cluster spawned via `npx generacy launch`. The cluster simulates the production failure scenario: compose file lives on the host, is NOT bind-mounted into the orchestrator container.

---

## Prerequisites

- Docker Desktop or Docker Engine 20.10+ (Engine API v1.41+) on the host machine.
- Node.js 22+ on the host (for `npx generacy launch`).
- A Generacy cloud account and access to the dashboard (for the claim code).
- Built `@generacy-ai/control-plane` package containing this branch's changes (deployed via cluster-base image build, OR locally bind-mounted into the orchestrator for dev — see "Dev iteration" below).

---

## Verifying the fix against a launched cluster

### 1. Launch a fresh cluster

```bash
# From a separate terminal — generates a claim code in the cloud dashboard
npx generacy launch --claim=<code>
```

Wait for the orchestrator container to come up. Confirm:

```bash
docker ps --filter "label=com.docker.compose.service=worker" --format '{{.Names}} {{.Status}}'
# Expect: <project>-worker-1   Up X seconds
```

### 2. Confirm the bug repros on the unfixed version

Before deploying the fix, ensure scale fails. Look for the orchestrator's project-config-files label:

```bash
docker inspect <project>-orchestrator-1 \
  --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
# Expect: a host path like /Users/<user>/Generacy/<project>/.generacy/docker-compose.yml
#         (NOT a /workspaces/... path inside the container)
```

Trigger scale from the cloud UI (or curl directly to the control-plane socket). Expect `ENOENT`-style error reaching `<workspace>/.generacy/docker-compose.yml`.

### 3. Deploy the fix and verify scale-up

```bash
# Trigger scale to 3 workers via the cloud UI's "scale workers" control
# (Equivalent direct call shown below for reference.)
```

Verify on the host:

```bash
docker compose ps --filter "label=com.docker.compose.service=worker"
# Expect three rows: <project>-worker-1, -worker-2, -worker-3
```

Verify labels (SC-003):

```bash
docker inspect <project>-worker-1 <project>-worker-2 <project>-worker-3 \
  --format '{{.Name}}: {{index .Config.Labels "com.docker.compose.container-number"}}'
# Expect:
# /<project>-worker-1: 1
# /<project>-worker-2: 2
# /<project>-worker-3: 3
```

Verify `cluster.yaml` reflects the scale (SC-005):

```bash
cat ~/Generacy/<project>/.generacy/cluster.yaml | grep workers
# Expect: workers: 3
```

### 4. Verify scale-down with exited-first removal (SC-011)

```bash
# Simulate a crashed worker:
docker stop <project>-worker-2

# Confirm it's exited:
docker ps -a --filter "name=<project>-worker-" --format '{{.Names}} {{.Status}}'
# Expect: worker-2  Exited

# Scale to 1 via the cloud UI
```

Verify the exited replica was removed first, then the highest-numbered running one:

```bash
docker ps -a --filter "label=com.docker.compose.service=worker" --format '{{.Names}}'
# Expect only: <project>-worker-1
```

### 5. Verify multi-network attachment (SC-008)

Requires a custom worker definition with multiple networks. Verify post-scale:

```bash
docker inspect <project>-worker-3 \
  --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}} {{end}}'
# Expect: same networks listed for <project>-worker-1
```

### 6. Verify partial failure semantics (SC-009)

This is a fault-injection scenario primarily exercised by unit test. To manually trigger: pause the daemon mid-scale (`docker pause <project>-worker-2` doesn't reach the create path; need to use `docker compose down -t 0` on the network mid-scale, brittle). Prefer the unit-test fixture.

---

## Calling the lifecycle endpoint directly (without the cloud UI)

The `worker-scale` action is dispatched via the control-plane Unix socket, which the orchestrator's relay bridge forwards to the cloud. To call it locally:

```bash
# Inside the orchestrator container:
docker exec <project>-orchestrator-1 sh -c '
  curl -X POST \
    --unix-socket /run/generacy-control-plane/control.sock \
    -H "Content-Type: application/json" \
    -H "x-generacy-actor-user-id: dev-test" \
    -d "{\"count\": 3}" \
    http://localhost/lifecycle/worker-scale
'
```

Expected response:

```json
{
  "accepted": true,
  "action": "worker-scale",
  "previousCount": 1,
  "requestedCount": 3,
  "actualCount": 3
}
```

---

## Dev iteration loop

For tight iteration on `worker-scaler.ts` without rebuilding/republishing the cluster-base image:

1. From this repo: `pnpm --filter @generacy-ai/control-plane build`
2. In the running orchestrator container, replace the installed `dist/services/worker-scaler.js`:
   ```bash
   docker cp packages/control-plane/dist/src/services/worker-scaler.js \
     <project>-orchestrator-1:/app/control-plane/dist/src/services/worker-scaler.js
   docker cp packages/control-plane/dist/src/services/docker-engine-client.js \
     <project>-orchestrator-1:/app/control-plane/dist/src/services/docker-engine-client.js
   ```
   (Adjust paths for actual install location — verify with `docker exec <project>-orchestrator-1 find / -name worker-scaler.js 2>/dev/null`.)
3. Restart the control-plane process inside the orchestrator container, or restart the container if simpler.

---

## Running the unit tests

```bash
cd packages/control-plane
pnpm test -- worker-scaler          # Pure helpers + orchestration with mocked Engine client
pnpm test -- docker-engine-client   # HTTP-over-Unix-socket transport
pnpm test -- lifecycle-worker-scale # Route handler (request validation + error code mapping)
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `DOCKER_DAEMON_UNAVAILABLE` in scale response | `/var/run/docker-host.sock` not mounted into orchestrator | Verify cluster-base devcontainer mounts `/var/run/docker.sock:/var/run/docker-host.sock` (DooD). |
| `ORCHESTRATOR_NOT_COMPOSE_MANAGED` | Orchestrator container has no `com.docker.compose.project` label (e.g. started via `docker run`, not compose) | Set `COMPOSE_PROJECT_NAME` env var on orchestrator, OR start via compose. |
| Replicas missing networks after scale-up | Source replica only on a subset of expected networks (the daemon's view doesn't match `docker-compose.yml`) | Re-`docker compose up` from the host to reconcile, then re-scale. The clone reads the daemon, not the compose file. |
| Container-number gaps after scale-up + scale-down | Bug in `assignContainerNumbers` — should always gap-fill first | File a regression; include `docker ps -a --filter label=com.docker.compose.service=worker` output. |
| `cluster.yaml.workers` doesn't match container count after partial failure | This is expected on `partial: true` responses — `actualCount` is written | Inspect the response payload for `actualCount`; retry the original scale request to converge. |
| `WORKER_COUNT` in `.env` is stale | Expected — `.env` is no longer written on scale (FR-010). Authoritative count is `cluster.yaml.workers` post-boot, or live Docker state. | No action needed. |
