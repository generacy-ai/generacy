# Contract: Lua scripts (RedisQueueAdapter)

## `ENQUEUE_IF_ABSENT_SCRIPT` — new

```lua
-- KEYS[1] = pending sorted set  = 'orchestrator:queue:pending'
-- KEYS[2] = in-flight SET       = 'orchestrator:queue:in-flight-items'
-- ARGV[1] = itemKey             (e.g., 'chris/sniplink#3')
-- ARGV[2] = priority            (numeric string; ZADD score)
-- ARGV[3] = serialized item     (JSON string; ZSET member payload)
--
-- Returns: 1 if enqueued, 0 if already in flight.
local exists = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if exists == 1 then
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[3])
return 1
```

### Registration

`RedisQueueAdapter` gains a `ensureEnqueueIfAbsentCommand()` gate identical in shape to the existing `ensureClaimCommand()` at line 73:

```ts
private enqueueIfAbsentCommandDefined = false;

private ensureEnqueueIfAbsentCommand(): void {
  if (this.enqueueIfAbsentCommandDefined) return;
  this.redis.defineCommand('enqueueIfAbsent', {
    numberOfKeys: 2,
    lua: ENQUEUE_IF_ABSENT_SCRIPT,
  });
  this.enqueueIfAbsentCommandDefined = true;
}
```

### Invocation

```ts
async enqueueIfAbsent(item: QueueItem): Promise<boolean> {
  this.ensureEnqueueIfAbsentCommand();
  const itemKey = buildItemKey(item);
  const priority = getPriorityScore(item.queueReason);
  const serialized: SerializedQueueItem = {
    ...item,
    priority,
    attemptCount: 0,
    itemKey,
  };
  try {
    const result = await (this.redis as any).enqueueIfAbsent(
      PENDING_KEY,
      IN_FLIGHT_KEY,
      itemKey,
      String(priority),
      JSON.stringify(serialized),
    );
    const enqueued = result === 1;
    if (enqueued) {
      this.logger.info(
        { owner: item.owner, repo: item.repo, issue: item.issueNumber, priority, itemKey },
        'Item enqueued to Redis sorted set (in-flight-checked)',
      );
    }
    return enqueued;
  } catch (error) {
    this.logger.warn(
      { err: error, itemKey },
      'Redis error in enqueueIfAbsent, dropping (fail-safe)',
    );
    return false;
  }
}
```

## `CLAIM_SCRIPT` — unchanged

The existing script (lines 20–31 of `redis-queue-adapter.ts`) needs no change: on claim, the item transitions from `pending` to `claimed:<workerId>` but stays in the in-flight SET. `SISMEMBER` still returns 1 for a claimed item — that is the intended behavior.

## SET maintenance outside Lua — `complete` and `release` (dead-letter branch)

`complete` (existing lines 206–224) becomes a `MULTI/EXEC` transaction:

```ts
async complete(workerId: string, item: QueueItem): Promise<void> {
  const itemKey = buildItemKey(item);
  const claimedKey = buildClaimedKey(workerId);
  const heartbeatKey = buildHeartbeatKey(workerId);
  try {
    await this.redis
      .multi()
      .hdel(claimedKey, itemKey)
      .del(heartbeatKey)
      .srem(IN_FLIGHT_KEY, itemKey)
      .exec();
    this.logger.info({ workerId, itemKey }, 'Item completed and removed from claimed set + in-flight index');
  } catch (error) {
    this.logger.warn({ err: error, workerId, itemKey }, 'Redis error in complete');
  }
}
```

`release` (existing lines 152–204) becomes:

```ts
async release(workerId: string, item: QueueItem): Promise<void> {
  const itemKey = buildItemKey(item);
  const claimedKey = buildClaimedKey(workerId);
  const heartbeatKey = buildHeartbeatKey(workerId);

  try {
    const claimedRaw = await this.redis.hget(claimedKey, itemKey);
    let attemptCount = 0;
    if (claimedRaw) {
      const parsed: SerializedQueueItem = JSON.parse(claimedRaw);
      attemptCount = parsed.attemptCount + 1;
    }

    if (attemptCount >= this.maxRetries) {
      // Dead-letter path — drop from in-flight index (item is no longer eligible)
      const deadLetterItem: SerializedQueueItem = { ...item, attemptCount, itemKey };
      await this.redis
        .multi()
        .hdel(claimedKey, itemKey)
        .del(heartbeatKey)
        .zadd(DEAD_LETTER_KEY, Date.now(), JSON.stringify(deadLetterItem))
        .srem(IN_FLIGHT_KEY, itemKey)
        .exec();
      this.logger.warn({ workerId, itemKey, attemptCount, maxRetries: this.maxRetries }, 'Item dead-lettered');
    } else {
      // Retry path — item stays in-flight (in SET), moves pending ← claimed
      const retryPriority = getPriorityScore('retry');
      const requeueItem: SerializedQueueItem = { ...item, queueReason: 'retry', priority: retryPriority, attemptCount, itemKey };
      await this.redis
        .multi()
        .hdel(claimedKey, itemKey)
        .del(heartbeatKey)
        .zadd(PENDING_KEY, retryPriority, JSON.stringify(requeueItem))
        .exec();
      this.logger.info({ workerId, itemKey, attemptCount }, 'Item released back to pending');
    }
  } catch (error) {
    this.logger.warn({ err: error, workerId, itemKey }, 'Redis error in release');
  }
}
```

## Constants

```ts
const IN_FLIGHT_KEY = 'orchestrator:queue:in-flight-items';
```

Add alongside the existing constants at the top of `redis-queue-adapter.ts`.

## Test harness note

`ioredis-mock` supports `defineCommand` with Lua scripts using the same KEYS/ARGV pattern as `CLAIM_SCRIPT`. Verify locally that the mock's Lua VM handles `SISMEMBER`/`SADD`/`ZADD` in an EVAL body before landing the integration test (`vitest run -t enqueueIfAbsent`); if a specific op is unsupported, fall back to a two-command `WATCH/MULTI/EXEC` compare-and-swap in the adapter code (still atomic, slightly more complex).
