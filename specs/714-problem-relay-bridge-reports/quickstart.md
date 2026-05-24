# Quickstart: verifying the fix

This document describes the manual flow to confirm that the relay metadata payload reports the *actual* worker container count rather than the YAML-declared value, and that the count updates within ~10s of a worker container exit.

## Prerequisites

- A cluster created via `npx generacy launch` (cloud flow), so the divergence the issue describes is present out of the box.
- Access to the orchestrator container's logs (`docker logs <project>-orchestrator-1 -f`).
- Access to the cloud UI's Cluster page for the same project.

## Setup

1. `cd ~/Generacy/<project>` (the launch-created project directory).
2. Confirm the divergence is in place:

   ```
   cat .generacy/cluster.yaml | grep workers     # → "workers: 3"  (template default)
   grep WORKER_COUNT .generacy/.env              # → "WORKER_COUNT=1"  (CLI default)
   docker compose ps --filter "service=worker"   # → 1 running container
   ```

3. Build the changed packages:

   ```bash
   pnpm --filter @generacy-ai/control-plane build
   pnpm --filter @generacy-ai/orchestrator build
   ```

4. Bring the orchestrator container up with the new build:

   ```bash
   docker compose up -d --force-recreate orchestrator
   ```

## Verification 1 — actual-count reporting (baseline)

1. Open the cloud UI's Cluster page for this project.
2. Expected: "Workers: 1 (0 busy, 1 idle)" — **not** 3.
3. Confirm via the orchestrator's metadata send log:

   ```bash
   docker logs <project>-orchestrator-1 2>&1 | grep -E 'metadata|workers' | tail -20
   ```

   You should see periodic metadata payloads with `workers: 1`.

## Verification 2 — responsiveness (event-triggered refresh)

1. With the cloud UI open, stop one worker:

   ```bash
   docker stop <project>-worker-1
   ```

2. Within ~10s, the UI tile should drop to "Workers: 0 (0 busy, 0 idle)".
3. Confirm via logs that a metadata send fired immediately:

   ```bash
   docker logs <project>-orchestrator-1 2>&1 | grep -E '"die"|sendMetadata|workers' | tail -10
   ```

## Verification 3 — startup ordering

1. Restart the orchestrator while no workers are running:

   ```bash
   docker stop <project>-worker-1
   docker compose restart orchestrator
   ```

2. The first metadata payload after boot should report `workers: 0` (not `3` from the YAML).
3. Bring a worker back up:

   ```bash
   docker compose up -d worker
   ```

4. The metadata payload should reflect `workers: 1` within ~10s of the new container reaching `running`.

## Verification 4 — failure path (omission, not fallback)

This requires temporarily denying the orchestrator access to the Docker socket. The simplest way is to stop the daemon socket from inside the orchestrator's mount (or rename the mounted socket and recreate the orchestrator). For most local verification you can skip this; the integration test covers it.

Expected: when `enumerateWorkers` throws, the next metadata payload **omits** the `workers` field entirely. The cloud UI should treat it as unknown rather than displaying the declared value.

## Troubleshooting

- **Tile still shows 3** — the orchestrator may still be running the old code. Check `docker logs <project>-orchestrator-1 | grep '@generacy-ai/orchestrator'` for the build hash, or recreate with `--force-recreate`.
- **Tile updates only every 60s** — the event subscription isn't running. Check orchestrator logs for `streamContainerEvents` connection errors or `ORCHESTRATOR_NOT_COMPOSE_MANAGED`.
- **`workers` field gone entirely** — Engine API is unreachable from the orchestrator. Check `ls -la /var/run/docker-host.sock` inside the container and confirm `DOCKER_HOST` env points to a real socket.
- **Container-number warning on stderr** — a manually-added worker container is missing the `com.docker.compose.container-number` label; it'll be skipped. Normal compose-managed replicas always carry the label.

## Available commands

This is a transparent change — no new CLI surface, no new endpoints. The only user-visible behavior is the cloud UI's Workers tile becoming accurate.
