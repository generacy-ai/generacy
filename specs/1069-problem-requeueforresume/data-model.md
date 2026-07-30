# Data Model: Atomic `requeueForResume()` / `release()` re-pend

## Interface change: NONE

**File**: `packages/orchestrator/src/types/monitor.ts` — **unchanged**.

Per FR-008 and SC-008, both methods retain their existing signatures:

```ts
export interface QueueManager {
  release(workerId: string, item: QueueItem): Promise<void>;
  requeueForResume(workerId: string, item: QueueItem): Promise<void>;
}
```

The fix is entirely internal to `RedisQueueAdapter`. External consumers (`WorkerDispatcher.handleLeaseExpired`, `WorkerDispatcher.completeWorker`, and their peers) see no signature change.

## Lua script contract: `REQUEUE_FOR_RESUME_SCRIPT`

**File**: `packages/orchestrator/src/services/redis-queue-adapter.ts` — new constant added alongside the three existing script constants (`ENQUEUE_IF_ABSENT_SCRIPT`, `CLAIM_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`).

**Keys** (`numberOfKeys: 3`):

| Position | Name         | Redis key                                       | Type      |
| -------- | ------------ | ----------------------------------------------- | --------- |
| KEYS[1]  | pending      | `orchestrator:queue:pending`                    | Sorted Set |
| KEYS[2]  | claimed hash | `orchestrator:queue:claimed:<workerId>`         | Hash      |
| KEYS[3]  | heartbeat    | `orchestrator:worker:<workerId>:heartbeat`      | String    |

**Args**:

| Position | Name              | Type            | Notes                                                     |
| -------- | ----------------- | --------------- | --------------------------------------------------------- |
| ARGV[1]  | itemKey           | string          | `<owner>/<repo>#<issue>`                                  |
| ARGV[2]  | resumePriority    | number (string) | Client-computed `getPriorityScore('resume')` (A4)         |
| ARGV[3]  | item JSON         | string          | `JSON.stringify(item)` — the base `QueueItem` fields used to reconstruct the re-pend payload (owner/repo/issueNumber/workflowName/command/enqueuedAt/metadata) |

**Return** (Lua array, mapped by `ioredis` to a JS array):

| Element index | Name         | Type   | Meaning                                                                                            |
| ------------- | ------------ | ------ | -------------------------------------------------------------------------------------------------- |
| 0             | code         | number | `0` = no-op / claim already cleared (reaper race). `1` = re-pended.                                |
| 1             | attemptCount | number | Post-mutation `attemptCount` on branch 1 (verbatim from the claim payload — NOT incremented, FR-003). Sentinel `-1` on branch 0. |

**Lua body**:

```lua
local claimed = redis.call('HGET', KEYS[2], ARGV[1])
if not claimed then
  -- Reaper (or another lease-expiry firing) already re-pended it.
  -- Best-effort DEL heartbeat to avoid stale key.
  redis.call('DEL', KEYS[3])
  return {0, -1}
end

local parsed = cjson.decode(claimed)
-- Merge base item fields from ARGV[3] with attemptCount from parsed.
-- Note: cjson.decode of ARGV[3] into `base` lets us set queueReason /
-- priority / claimedAt cleanly without touching whatever else the caller
-- packed into `item`.
local base = cjson.decode(ARGV[3])
base.queueReason = 'resume'
base.priority = tonumber(ARGV[2])
base.attemptCount = parsed.attemptCount  -- FR-003: verbatim, no bump
base.itemKey = ARGV[1]
base.claimedAt = nil  -- A6: strip claim-lifecycle field
local repayload = cjson.encode(base)

redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), repayload)

return {1, parsed.attemptCount}
```

**Invariant preservation** (FR-006): this script does NOT touch `IN_FLIGHT_KEY`. The item was in-flight before the call (via claim), the item is in-flight after the call (via pending). No `SREM`.

## Lua script contract: `RELEASE_SCRIPT`

**File**: same file, new constant.

**Keys** (`numberOfKeys: 5`):

| Position | Name          | Redis key                                       | Type      |
| -------- | ------------- | ----------------------------------------------- | --------- |
| KEYS[1]  | pending       | `orchestrator:queue:pending`                    | Sorted Set |
| KEYS[2]  | claimed hash  | `orchestrator:queue:claimed:<workerId>`         | Hash      |
| KEYS[3]  | heartbeat     | `orchestrator:worker:<workerId>:heartbeat`      | String    |
| KEYS[4]  | dead-letter   | `orchestrator:queue:dead-letter`                | Sorted Set |
| KEYS[5]  | in-flight SET | `orchestrator:queue:in-flight-items`            | Set       |

**Args**:

| Position | Name           | Type            | Notes                                                              |
| -------- | -------------- | --------------- | ------------------------------------------------------------------ |
| ARGV[1]  | itemKey        | string          | `<owner>/<repo>#<issue>`                                           |
| ARGV[2]  | retryPriority  | number (string) | Client-computed `getPriorityScore('retry')` (A4)                   |
| ARGV[3]  | item JSON      | string          | `JSON.stringify(item)` — base `QueueItem` fields                    |
| ARGV[4]  | maxRetries    | number (string) | Client-side threshold; script dispatches dead-letter at `attemptCount + 1 >= maxRetries` (FR-004) |
| ARGV[5]  | nowMs         | number (string) | `Date.now()` — used as ZADD score for the dead-letter entry (matches current `Date.now()` write at `redis-queue-adapter.ts:774`) |

**Return** (Lua array):

| Element index | Name         | Type   | Meaning                                                                       |
| ------------- | ------------ | ------ | ----------------------------------------------------------------------------- |
| 0             | code         | number | `0` = no-op / claim already cleared. `1` = retry re-pended. `2` = dead-lettered. |
| 1             | attemptCount | number | Post-mutation `parsed.attemptCount + 1` on branches 1 and 2. Sentinel `-1` on branch 0. |

**Lua body**:

```lua
local claimed = redis.call('HGET', KEYS[2], ARGV[1])
if not claimed then
  -- Reaper (or another release firing) already re-pended it. Skip re-pend
  -- to avoid a duplicate pending member (spec §Summary).
  redis.call('DEL', KEYS[3])
  return {0, -1}
end

local parsed = cjson.decode(claimed)
local attemptCount = parsed.attemptCount + 1  -- FR-004: +1 on the retry side
local maxRetries = tonumber(ARGV[4])
local base = cjson.decode(ARGV[3])
base.attemptCount = attemptCount
base.itemKey = ARGV[1]
base.claimedAt = nil

if attemptCount >= maxRetries then
  -- FR-002 Q1=A: dead-letter branch folded into the same script.
  -- FR-006: SREM IN_FLIGHT_KEY fires ONLY on this branch.
  local dlpayload = cjson.encode(base)
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('DEL', KEYS[3])
  redis.call('ZADD', KEYS[4], tonumber(ARGV[5]), dlpayload)
  redis.call('SREM', KEYS[5], ARGV[1])
  return {2, attemptCount}
end

-- Retry branch. In-flight membership preserved (no SREM — FR-006).
base.queueReason = 'retry'
base.priority = tonumber(ARGV[2])
local repayload = cjson.encode(base)
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), repayload)
return {1, attemptCount}
```

**Invariant preservation** (FR-006):

- **Retry branch**: no `SREM IN_FLIGHT_KEY`. Item was in-flight (claim), item is in-flight (pending). Same as `requeueForResume`.
- **Dead-letter branch**: `SREM IN_FLIGHT_KEY`. Item was in-flight, item is now in dead-letter (permanently out-of-flight). Matches current behaviour at `redis-queue-adapter.ts:775`.
- **No-op branch**: no `SREM`. Whichever concurrent actor won the race is responsible for the invariant (they mirror this contract).

## `SerializedQueueItem` schema (unchanged)

The `SerializedQueueItem` interface at `packages/orchestrator/src/types/index.ts` is untouched. Both scripts read/write the exact shape currently used at `redis-queue-adapter.ts:789-795` (`release` retry re-pend) and `:864-872` (`requeueForResume` re-pend). Field-by-field parity:

| Field         | Source in script                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| owner         | `base.owner` from `cjson.decode(ARGV[3])`                                                                    |
| repo          | `base.repo` from `cjson.decode(ARGV[3])`                                                                     |
| issueNumber   | `base.issueNumber` from `cjson.decode(ARGV[3])`                                                              |
| workflowName  | `base.workflowName` from `cjson.decode(ARGV[3])`                                                             |
| command       | `base.command` from `cjson.decode(ARGV[3])`                                                                  |
| priority      | overwritten with `tonumber(ARGV[2])` (`retryPriority` or `resumePriority`)                                   |
| enqueuedAt    | `base.enqueuedAt` from `cjson.decode(ARGV[3])`                                                               |
| metadata      | `base.metadata` from `cjson.decode(ARGV[3])`                                                                 |
| queueReason   | overwritten with `'retry'` (release) or `'resume'` (requeueForResume). Preserved on dead-letter (per current write at `:765-769` — dead-letter re-uses `...item` spread which carries the original `queueReason`). |
| attemptCount  | `parsed.attemptCount` (verbatim, requeueForResume) or `parsed.attemptCount + 1` (release, both branches)     |
| itemKey       | `ARGV[1]` (`<owner>/<repo>#<issue>`)                                                                          |
| claimedAt     | set to `nil` before re-encode (A6 — strip claim-lifecycle field for `requeueForResume`; unused by dead-letter and retry re-pend paths but stripped defensively for parity) |

## New adapter fields

**File**: `packages/orchestrator/src/services/redis-queue-adapter.ts`.

Two new private boolean flags following the existing `claimCommandDefined` / `enqueueIfAbsentCommandDefined` / `reclaimOrphanCommandDefined` pattern at `:190-192`:

```ts
private releaseCommandDefined = false;
private requeueForResumeCommandDefined = false;
```

Two new `ensureXCommand()` helper methods following the pattern at `:225-250`:

```ts
private ensureReleaseCommand(): void {
  if (this.releaseCommandDefined) return;
  this.redis.defineCommand('releaseItem', {
    numberOfKeys: 5,
    lua: RELEASE_SCRIPT,
  });
  this.releaseCommandDefined = true;
}

private ensureRequeueForResumeCommand(): void {
  if (this.requeueForResumeCommandDefined) return;
  this.redis.defineCommand('requeueForResumeItem', {
    numberOfKeys: 3,
    lua: REQUEUE_FOR_RESUME_SCRIPT,
  });
  this.requeueForResumeCommandDefined = true;
}
```

Command names use the `Item` suffix (`releaseItem`, `requeueForResumeItem`) to avoid shadowing the adapter's own public method names (`release`, `requeueForResume`) on the ioredis client object — same convention as `enqueueItem` (renamed to `enqueueIfAbsent` after #1065 consolidation, per script-wiring test comments).

## Test-facing exports

Two new `@internal` const-exports following the `_ENQUEUE_IF_ABSENT_SCRIPT_FOR_TESTS` pattern at `redis-queue-adapter.ts:60-67`:

```ts
export const _RELEASE_SCRIPT_FOR_TESTS = RELEASE_SCRIPT;
export const _REQUEUE_FOR_RESUME_SCRIPT_FOR_TESTS = REQUEUE_FOR_RESUME_SCRIPT;
```

Consumed by `redis-queue-adapter.script-wiring.test.ts` for byte-exact static assertions (FR-012).

## Caller-side data flow after the rewrite

**`release()` post-rewrite** (schematic; full code shape in `contracts/release-script.md`):

```ts
async release(workerId: string, item: QueueItem): Promise<void> {
  this.ensureReleaseCommand();
  const itemKey = buildItemKey(item);
  const claimedKey = buildClaimedKey(workerId);
  const heartbeatKey = buildHeartbeatKey(workerId);
  const retryPriority = getPriorityScore('retry');

  try {
    const [code, attemptCount] = await (this.redis as any).releaseItem(
      PENDING_KEY,
      claimedKey,
      heartbeatKey,
      DEAD_LETTER_KEY,
      IN_FLIGHT_KEY,
      itemKey,
      String(retryPriority),
      JSON.stringify(item),
      String(this.maxRetries),
      String(Date.now()),
    );
    switch (code) {
      case 0:
        this.logger.info({ workerId, itemKey },
          'release() called on already-cleared claim (reaper race) — skipping re-pend to avoid duplicate pending member');
        return;
      case 1:
        this.logger.info({ workerId, itemKey, attemptCount },
          'Item released back to pending queue');
        return;
      case 2:
        this.dropLogState.delete(itemKey);
        this.enqueuedAtCache.delete(itemKey);
        this.logger.warn({ workerId, itemKey, attemptCount, maxRetries: this.maxRetries },
          'Item dead-lettered after max retries');
        return;
    }
  } catch (error) {
    this.logger.warn({ err: error, workerId, itemKey }, 'Redis error in release');
  }
}
```

**`requeueForResume()` post-rewrite** (schematic; full code shape in `contracts/requeue-for-resume-script.md`):

```ts
async requeueForResume(workerId: string, item: QueueItem): Promise<void> {
  this.ensureRequeueForResumeCommand();
  const itemKey = buildItemKey(item);
  const claimedKey = buildClaimedKey(workerId);
  const heartbeatKey = buildHeartbeatKey(workerId);
  const resumePriority = getPriorityScore('resume');

  try {
    const [code, attemptCount] = await (this.redis as any).requeueForResumeItem(
      PENDING_KEY,
      claimedKey,
      heartbeatKey,
      itemKey,
      String(resumePriority),
      JSON.stringify(item),
    );
    switch (code) {
      case 0:
        this.logger.info({ workerId, itemKey },
          'requeueForResume() called on already-cleared claim (reaper race) — skipping re-pend');
        return;
      case 1:
        this.logger.info({ workerId, itemKey, attemptCount, reason: 'lease-expiry' },
          'Item re-pended at resume priority (attemptCount preserved)');
        return;
    }
  } catch (error) {
    this.logger.warn({ err: error, workerId, itemKey }, 'Redis error in requeueForResume');
  }
}
```

Each method's log lines (message text + field shape) match the current implementation byte-for-byte per FR-005 + SC-007.

## Cross-adapter parity table

| Observable                      | RedisQueueAdapter (post-fix)                                                                        | InMemoryQueueAdapter (unchanged)                                                             | Parity? |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------- |
| `release()` return type         | `Promise<void>`                                                                                     | `Promise<void>`                                                                              | ✅       |
| `requeueForResume()` return type | `Promise<void>`                                                                                    | `Promise<void>`                                                                              | ✅       |
| No-op log line (both methods)   | `'... called on already-cleared claim ... — skipping re-pend ...'` info, `{workerId, itemKey}`      | Same message + same fields (already implemented at in-memory `:236-240` and `:296-300`)      | ✅       |
| Retry log line                  | `'Item released back to pending queue'` info, `{workerId, itemKey, attemptCount}`                    | Same message + same fields (in-memory `:278-281`)                                            | ✅       |
| Dead-letter log line            | `'Item dead-lettered after max retries'` warn, `{workerId, itemKey, attemptCount, maxRetries}`      | Same message + same fields (in-memory `:263-266`)                                            | ✅       |
| Resume log line                 | `'Item re-pended at resume priority (attemptCount preserved)'` info, `{workerId, itemKey, attemptCount, reason: 'lease-expiry'}` | Same message + same fields (in-memory `:319-327`)                     | ✅       |
| Atomicity of read + mutate      | Single Lua script (post-fix)                                                                        | Trivially atomic (single-threaded, single process)                                            | ✅       |
| Round-trip count on happy path  | 1 (post-fix; excludes null-guard `DEL heartbeat`)                                                    | N/A                                                                                          | N/A     |
| `IN_FLIGHT_KEY` preservation on retry / resume | Preserved (no `SREM`)                                                                | `inFlightSet.delete()` deferred to complete/dead-letter                                       | ✅       |
| `IN_FLIGHT_KEY` removal on dead-letter | `SREM` inside `RELEASE_SCRIPT`                                                                | `inFlightSet.delete()` in `release()` retry-attempt-max branch (in-memory `:260`)             | ✅       |
