# Quickstart: In-Flight-Keyed Resume Dedupe (#862)

Verifying the durable fix locally end-to-end.

## Prerequisites

- Node ≥22.
- `pnpm install` from repo root.
- The dev stack script for Redis (Firebase emulators not needed for this feature):
  ```bash
  /workspaces/tetrad-development/scripts/stack start
  source /workspaces/tetrad-development/scripts/stack-env.sh
  ```

## Build & test

From `packages/orchestrator`:

```bash
pnpm build
pnpm test -- --run inflight-resume-dedupe
```

Runs the new integration test at `src/__tests__/inflight-resume-dedupe.integration.test.ts`.

Full targeted test slice:

```bash
pnpm test -- --run redis-queue-adapter.enqueueIfAbsent inflight-resume-dedupe
```

## Manual repro — the stranded scenario

The whole point of this spec is that the #862 stranding scenario becomes *unreproducible*. To verify:

1. Ensure a healthy live cluster (any repo works). Pick an issue you have write access to.
2. Attach a `waiting-for:implementation-review` label to the issue.
3. Attach a `completed:implementation-review` label to the same issue. Expected: within one poll cycle (~30 s), the orchestrator logs
   ```
   info Processing resume label event
   info Item enqueued to Redis sorted set (in-flight-checked)
   info Issue enqueued (resume)
   ```
   The item is picked up by a worker.
4. Wait for the worker to complete or manually simulate completion (`gh label ... rm waiting-for:implementation-review completed:implementation-review`).
5. Re-attach both labels. Expected: same log sequence, the item enqueues again with no manual `redis DEL` intervention.

Under the pre-fix behavior (with #849 alone, on a cluster where the stale key survives), step 5 would emit
```
info Duplicate event detected (phase-tracker:...:resume:implementation-review)
```
and drop silently — which is the incident this spec closes.

## Redis inspection

After a resume enqueue:

```bash
redis-cli -h 127.0.0.1 -p 6379
> SMEMBERS orchestrator:queue:in-flight-items
1) "chris/sniplink#3"
> ZRANGE orchestrator:queue:pending 0 -1 WITHSCORES
1) "{\"owner\":\"chris\",...\"itemKey\":\"chris/sniplink#3\"}"
2) "1720434567890"
```

After a worker completes the item:

```
> SMEMBERS orchestrator:queue:in-flight-items
(empty array)
> HKEYS orchestrator:queue:claimed:<worker-id>
(empty array)
```

Verify no stale `phase-tracker:*:resume:*` keys are created by the new code:

```
> KEYS phase-tracker:*:resume:*
(empty array)      # for any freshly-triggered resume; pre-existing keys will age out under 24h TTL
```

## Test-harness gotchas

- The integration test uses `ioredis-mock` in `RedisMock` mode. Verify Lua `defineCommand` support for the new `ENQUEUE_IF_ABSENT_SCRIPT` by adding one assertion after adapter instantiation:
  ```ts
  await expect(adapter.enqueueIfAbsent(sampleItem)).resolves.toBe(true);
  await expect(adapter.enqueueIfAbsent(sampleItem)).resolves.toBe(false);
  ```
- If `ioredis-mock` does not correctly execute `SISMEMBER + SADD + ZADD` inside a Lua body, the adapter can fall back to a `WATCH/MULTI/EXEC` compare-and-swap that is still atomic. The observable contract stays the same, so no test change is required.

## Cleanup / rollback

Rollback: revert this branch. The old #849 paired-clear machinery works as before once restored. Existing `orchestrator:queue:in-flight-items` SET members will leak until they naturally drain (any subsequent `enqueue`/`claim`/`release`/`complete` on the same `itemKey` in restored code will leave the SET untouched — it will be pruned only on operator flush or Redis restart). Non-blocking; no correctness impact on rolled-back code paths.

## Where to look for what

| I want to see…                                                       | Look here                                                                   |
|----------------------------------------------------------------------|------------------------------------------------------------------------------|
| The new atomic primitive                                             | `packages/orchestrator/src/services/redis-queue-adapter.ts` — `enqueueIfAbsent` |
| The Lua script                                                       | Same file, `ENQUEUE_IF_ABSENT_SCRIPT` constant                              |
| Where dedupe used to fire (deleted)                                  | `label-monitor-service.ts:276–289` — old `phaseTracker.isDuplicate` block   |
| Where the paired-clear used to be (deleted)                          | `label-manager.ts:onGateHit`, `claude-cli-worker.ts:406–422`                |
| The regression test                                                  | `src/__tests__/inflight-resume-dedupe.integration.test.ts`                  |
| The superseded #849 test                                             | `src/__tests__/paired-resume-dedupe-clear.integration.test.ts` — DELETED    |
