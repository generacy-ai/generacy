import type { Redis } from 'ioredis';
import type {
  QueueItem,
  QueueItemWithScore,
  QueueManager,
  ReapReport,
  ReclaimedItem,
  SerializedQueueItem,
} from '../types/index.js';
import type { DispatchConfig } from '../config/index.js';
import { getPriorityScore } from './queue-priority.js';
import {
  classifyDropSeverity,
  emitDropLog,
  type DropTransitionState,
} from './drop-log-helper.js';

const PENDING_KEY = 'orchestrator:queue:pending';
const CLAIMED_KEY_PREFIX = 'orchestrator:queue:claimed:';
const HEARTBEAT_KEY_PREFIX = 'orchestrator:worker:';
const DEAD_LETTER_KEY = 'orchestrator:queue:dead-letter';
const IN_FLIGHT_KEY = 'orchestrator:queue:in-flight-items';
const DEDUP_KEY_PREFIX = 'orchestrator:queue:_dedup:';

/**
 * Lua script for atomic in-flight-checked enqueue.
 * KEYS[1] = pending sorted set
 * KEYS[2] = in-flight SET
 * ARGV[1] = itemKey
 * ARGV[2] = priority (numeric string)
 * ARGV[3] = serialized item JSON
 *
 * Returns 1 if enqueued, 0 if already in flight.
 */
const ENQUEUE_IF_ABSENT_SCRIPT = `
local exists = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if exists == 1 then
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[3])
return 1
`;

/**
 * #1060 — Lua script for atomic in-flight-checked enqueue on the
 * `enqueue()` path. Byte-identical to `ENQUEUE_IF_ABSENT_SCRIPT`; the two
 * verbs share the same atomic dedupe-and-add sequence and differ only in
 * how the caller reads the boolean return.
 *
 * Restores the `in-flight = pending ∪ claimed` invariant on the
 * `process:<workflow>` intake path — before this script existed, `enqueue()`
 * ran a plain `ZADD pending` with no in-flight SET add and no dedupe, so a
 * subsequent monitor `enqueueIfAbsent` for the same itemKey passed its
 * SISMEMBER guard and produced a second distinct pending member.
 *
 * KEYS[1] = pending sorted set
 * KEYS[2] = in-flight SET
 * KEYS[3] = `_dedup:<itemKey>` hash (reserved for future D6-a upgrade;
 *           the D6-b body below does not touch it)
 * ARGV[1] = itemKey
 * ARGV[2] = priority (numeric string)
 * ARGV[3] = serialized item JSON
 *
 * Returns 1 if enqueued, 0 if already in flight.
 */
const ENQUEUE_SCRIPT = `
local exists = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if exists == 1 then
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[3])
return 1
`;

/**
 * Lua script for atomic claim: ZPOPMIN + HSET claimed + SET heartbeat.
 * KEYS[1] = pending sorted set
 * KEYS[2] = claimed hash for this worker
 * KEYS[3] = heartbeat key for this worker
 * ARGV[1] = heartbeat TTL in seconds
 * ARGV[2] = ISO-8601 claimedAt timestamp (client-computed at call time)
 *
 * #1054 finding 3 — stamps `claimedAt` into the persisted claim payload
 * so the reaper's grace-window can measure age-since-CLAIM rather than
 * age-since-ENQUEUE (an item that waited hours in pending must not skip
 * the grace window the instant it's claimed). Legacy payloads written
 * before this field existed fall back to `enqueuedAt` on the reap side.
 *
 * Returns the serialized item string (with claimedAt injected), or nil
 * if queue is empty.
 */
const CLAIM_SCRIPT = `
local result = redis.call('ZPOPMIN', KEYS[1], 1)
if #result == 0 then
  return nil
end
local member = result[1]
local parsed = cjson.decode(member)
parsed.claimedAt = ARGV[2]
local reserialized = cjson.encode(parsed)
local itemKey = parsed.itemKey
redis.call('HSET', KEYS[2], itemKey, reserialized)
redis.call('SET', KEYS[3], '1', 'EX', tonumber(ARGV[1]))
return reserialized
`;

/**
 * #1054 — Reclaim an orphaned claim atomically. Server-side re-check of the
 * heartbeat key (US2 race safety) and grace-window guard (FR-005) live
 * inside the script body — the outer-loop `EXISTS` check the caller does
 * before invoking this script is a fast-path optimization; this script is
 * the load-bearing guard.
 *
 * #1054 finding 1 — this script does NOT SREM the in-flight SET. A
 * reclaimed item is legitimately still in flight (moved from claimed back
 * to pending), so the in-flight = pending ∪ claimed invariant would be
 * broken by SREM + ZADD together — the ZSET would then hold two distinct
 * members for the same itemKey (Redis ZSETs key on the member string,
 * and the reclaim payload differs from any future monitor re-enqueue).
 * This mirrors `release()`'s retry-branch pattern (HDEL + DEL + ZADD, no
 * SREM), which only `complete()` and the dead-letter branch fire.
 *
 * KEYS[1] = orchestrator:queue:claimed:<workerId>
 * KEYS[2] = orchestrator:worker:<workerId>:heartbeat
 * KEYS[3] = orchestrator:queue:pending
 * ARGV[1] = itemKey
 * ARGV[2] = ageMs (client-computed: now - Date.parse(claimed.claimedAt ?? claimed.enqueuedAt))
 * ARGV[3] = graceWindowMs
 * ARGV[4] = resumePriority (numeric string; "0" for 'resume')
 * ARGV[5] = pre-serialized reclaim-item JSON (reclaimCount++, queueReason='resume')
 *
 * Return codes:
 *   0 = no-op (claim hash field absent; concurrent reclaim already ran)
 *   1 = reclaimed
 *   2 = heartbeat re-appeared server-side (US2 abort)
 *   3 = within grace window (FR-005 abort)
 */
const RECLAIM_ORPHAN_SCRIPT = `
local claimed = redis.call('HGET', KEYS[1], ARGV[1])
if not claimed then
  return 0
end

if redis.call('EXISTS', KEYS[2]) == 1 then
  return 2
end

if tonumber(ARGV[2]) < tonumber(ARGV[3]) then
  return 3
end

redis.call('HDEL', KEYS[1], ARGV[1])
if redis.call('HLEN', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
end

redis.call('ZADD', KEYS[3], tonumber(ARGV[4]), ARGV[5])

return 1
`;

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

function buildItemKey(item: QueueItem): string {
  return `${item.owner}/${item.repo}#${item.issueNumber}`;
}

function buildClaimedKey(workerId: string): string {
  return `${CLAIMED_KEY_PREFIX}${workerId}`;
}

function buildHeartbeatKey(workerId: string): string {
  return `${HEARTBEAT_KEY_PREFIX}${workerId}:heartbeat`;
}

/**
 * Redis sorted-set backed queue adapter implementing QueueManager.
 * Uses ZADD for priority ordering and a Lua script for atomic claim.
 * Gracefully degrades on Redis errors (logs warnings, doesn't crash).
 */
export class RedisQueueAdapter implements QueueManager {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly maxRetries: number;
  private readonly maxRunDurationMs: number;
  private readonly heartbeatCheckIntervalMs: number;
  private claimCommandDefined = false;
  private enqueueIfAbsentCommandDefined = false;
  private enqueueCommandDefined = false;
  private reclaimOrphanCommandDefined = false;
  /**
   * #1054 / FR-006 — per-itemKey severity state for the `enqueueIfAbsent`
   * drop-log transition-edge decision. Cleared on `complete()` (R6 mitigation)
   * and on successful reclaim (via `reapOrphanClaims`) to keep growth bounded.
   */
  private readonly dropLogState = new Map<string, DropTransitionState>();
  /**
   * #1054 finding 7 — amortized `enqueuedAt` cache. The collision path (fired
   * every ~5 min per in-flight issue by four monitors — hot in practice,
   * contrary to the earlier "not hot" comment) reads from this cache first
   * so `hasInFlightAge` doesn't fan out into an O(workers) SCAN + HGET per
   * drop. Populated by (a) `enqueueIfAbsent` on successful enqueue, (b) the
   * reaper on every HGETALL, (c) any explicit `hasInFlightAge` scan fallback.
   * Cleared by `complete()`, dead-letter, and successful reclaim.
   */
  private readonly enqueuedAtCache = new Map<string, number>();

  constructor(
    redis: Redis,
    logger: Logger,
    config?: Pick<
      DispatchConfig,
      'maxRetries' | 'maxRunDurationMs' | 'heartbeatCheckIntervalMs'
    >,
  ) {
    this.redis = redis;
    this.logger = logger;
    this.maxRetries = config?.maxRetries ?? 3;
    this.maxRunDurationMs = config?.maxRunDurationMs ?? 1_800_000;
    this.heartbeatCheckIntervalMs = config?.heartbeatCheckIntervalMs ?? 15_000;
  }

  private ensureClaimCommand(): void {
    if (this.claimCommandDefined) return;
    this.redis.defineCommand('claimItem', {
      numberOfKeys: 3,
      lua: CLAIM_SCRIPT,
    });
    this.claimCommandDefined = true;
  }

  private ensureEnqueueIfAbsentCommand(): void {
    if (this.enqueueIfAbsentCommandDefined) return;
    this.redis.defineCommand('enqueueIfAbsent', {
      numberOfKeys: 2,
      lua: ENQUEUE_IF_ABSENT_SCRIPT,
    });
    this.enqueueIfAbsentCommandDefined = true;
  }

  private ensureEnqueueCommand(): void {
    if (this.enqueueCommandDefined) return;
    this.redis.defineCommand('enqueueItem', {
      numberOfKeys: 3,
      lua: ENQUEUE_SCRIPT,
    });
    this.enqueueCommandDefined = true;
  }

  private ensureReclaimOrphanCommand(): void {
    if (this.reclaimOrphanCommandDefined) return;
    this.redis.defineCommand('reclaimOrphan', {
      numberOfKeys: 3,
      lua: RECLAIM_ORPHAN_SCRIPT,
    });
    this.reclaimOrphanCommandDefined = true;
  }

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
        // #1054 finding 7 — seed the enqueuedAt cache so subsequent drop-path
        // reads don't fan out into an O(workers) SCAN.
        const enqueuedAtMs = Date.parse(item.enqueuedAt);
        if (!Number.isNaN(enqueuedAtMs)) {
          this.enqueuedAtCache.set(itemKey, enqueuedAtMs);
        }
        this.logger.info(
          { owner: item.owner, repo: item.repo, issue: item.issueNumber, priority, itemKey },
          'Item enqueued to Redis sorted set (in-flight-checked)',
        );
      } else {
        // #879 / FR-009: structured drop signal for the in-flight-collision path.
        // Distinct from the Redis-error warn path below.
        // #1054 / FR-006: severity escalates from `info` to `warn` on the
        // transition edge when the wedged in-flight entry's age crosses
        // `maxRunDurationMs`. Structured fields preserved verbatim so
        // downstream log queries and alerts key on unchanged shape.
        const ageMs = await this.hasInFlightAge(itemKey);
        const decision = classifyDropSeverity(
          itemKey,
          ageMs,
          this.maxRunDurationMs,
          this.dropLogState,
        );
        emitDropLog(
          this.logger,
          decision,
          { itemKey, reason: 'in-flight', ageMs },
          'Dropping enqueue (item already in flight)',
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

  async hasInFlight(itemKey: string): Promise<boolean> {
    try {
      const result = await this.redis.sismember(IN_FLIGHT_KEY, itemKey);
      return result === 1;
    } catch (error) {
      this.logger.warn({ err: error, itemKey }, 'Redis error in hasInFlight');
      return false;
    }
  }

  /**
   * #1054 / FR-006 / FR-007 — return the age in ms of the given itemKey's
   * in-flight entry (pending OR claimed), or `null` if not in flight or on
   * transport error (fail-safe per AD-11).
   *
   * #1054 finding 8 — checks BOTH pending (ZSET) and claimed (per-worker
   * hashes) so the drop-log severity dispatcher escalates for pending-side
   * wedges too, matching `InMemoryQueueAdapter.hasInFlightAge`. Without
   * pending coverage, a reclaimed item sitting in pending while dispatch
   * is stalled (worker cap / lease-denied pausePolling) never crosses the
   * warn threshold and reproduces the invisible-wedge shape #1054 set out
   * to eliminate.
   *
   * #1054 finding 7 — cache-first read path amortizes the O(workers) SCAN
   * across drops. `enqueuedAtCache` is populated by `enqueueIfAbsent`,
   * `reapOrphanClaims`, and this method's own fallback scan. Cache miss
   * falls back to a full scan (pending + claimed) and populates.
   */
  async hasInFlightAge(itemKey: string): Promise<number | null> {
    const now = Date.now();
    const cached = this.enqueuedAtCache.get(itemKey);
    if (cached !== undefined) {
      return now - cached;
    }

    try {
      // Pending-side scan (finding 8 — parity with in-memory adapter). ZSCAN
      // over member strings would require parsing each; simpler + correct to
      // ZRANGE the whole set. Called only on cache miss, not every drop.
      const pendingMembers = await this.redis.zrange(PENDING_KEY, 0, -1);
      for (const member of pendingMembers) {
        try {
          const parsed: SerializedQueueItem = JSON.parse(member);
          if (parsed.itemKey !== itemKey) continue;
          const enqueuedAtMs = Date.parse(parsed.enqueuedAt);
          if (Number.isNaN(enqueuedAtMs)) return null;
          this.enqueuedAtCache.set(itemKey, enqueuedAtMs);
          return now - enqueuedAtMs;
        } catch {
          continue;
        }
      }

      // Claimed-side scan.
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          `${CLAIMED_KEY_PREFIX}*`,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        for (const key of keys) {
          const payload = await this.redis.hget(key, itemKey);
          if (!payload) continue;
          try {
            const parsed: SerializedQueueItem = JSON.parse(payload);
            const enqueuedAtMs = Date.parse(parsed.enqueuedAt);
            if (Number.isNaN(enqueuedAtMs)) return null;
            this.enqueuedAtCache.set(itemKey, enqueuedAtMs);
            return now - enqueuedAtMs;
          } catch {
            return null;
          }
        }
      } while (cursor !== '0');
      return null;
    } catch (error) {
      this.logger.warn(
        { err: error, itemKey },
        'Redis error in hasInFlightAge',
      );
      return null;
    }
  }

  /**
   * #1054 / FR-001 / FR-002 / FR-004 — Redis-side reap sweep. Reclaims
   * `orchestrator:queue:claimed:*` hashes whose owning worker heartbeat is
   * absent, re-enqueues with `queueReason: 'resume'` and `attemptCount++`.
   *
   * Race safety (US2): the outer-loop `EXISTS` check is an optimization;
   * the load-bearing guard is the server-side re-check inside the Lua
   * script. Grace window (FR-005): claims younger than
   * `2 × heartbeatCheckIntervalMs` are skipped.
   *
   * Never throws. On transport error mid-sweep: `warn` + return the
   * partial report so subsequent cycles retry.
   *
   * #1054 finding 6 — KNOWN RESIDUE: the sweep is candidate-set-driven by
   * `claimed:*` keys, so an in-flight-SET member whose backing claim hash
   * was evicted / HDEL'd without a paired SREM is unreachable from here.
   * The chosen direction is right for the reported incident (heartbeat-
   * ABSENT candidates), but a periodic `in-flight-items \ (pending ∪
   * claimed)` reconciliation would close the residual gap. Tracked in #1058.
   */
  async reapOrphanClaims(now: number = Date.now()): Promise<ReapReport> {
    this.ensureReclaimOrphanCommand();

    const report: ReapReport = {
      scanned: 0,
      reclaimed: [],
      skippedRaceReappeared: 0,
      skippedGraceWindow: 0,
    };
    const graceWindowMs = 2 * this.heartbeatCheckIntervalMs;
    const resumePriority = getPriorityScore('resume');

    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          `${CLAIMED_KEY_PREFIX}*`,
          'COUNT',
          100,
        );
        cursor = nextCursor;

        for (const claimedKey of keys) {
          const workerId = claimedKey.slice(CLAIMED_KEY_PREFIX.length);
          const heartbeatKey = buildHeartbeatKey(workerId);

          let fields: Record<string, string>;
          try {
            fields = await this.redis.hgetall(claimedKey);
          } catch (error) {
            this.logger.warn(
              { err: error, workerId },
              'Redis error in reapOrphanClaims (HGETALL), continuing sweep',
            );
            continue;
          }
          if (!fields || Object.keys(fields).length === 0) continue;

          // Fast-path optimization: skip whole worker if heartbeat is alive.
          try {
            const alive = await this.redis.exists(heartbeatKey);
            if (alive === 1) {
              // scanned counts per-(workerId, itemKey) pair; even though we
              // fast-skip we still counted them (they existed in the hash).
              report.scanned += Object.keys(fields).length;
              continue;
            }
          } catch (error) {
            this.logger.warn(
              { err: error, workerId },
              'Redis error in reapOrphanClaims (EXISTS), continuing sweep',
            );
            continue;
          }

          for (const [itemKey, payload] of Object.entries(fields)) {
            report.scanned += 1;

            let parsed: SerializedQueueItem;
            try {
              parsed = JSON.parse(payload);
            } catch (error) {
              this.logger.warn(
                { err: error, workerId, itemKey },
                'Malformed claim payload in reapOrphanClaims, skipping',
              );
              continue;
            }

            // #1054 finding 3 — grace-window measures age-since-CLAIM, not
            // age-since-ENQUEUE. Fall back to enqueuedAt for legacy claim
            // payloads written before CLAIM_SCRIPT stamped claimedAt.
            const ageBasisIso = parsed.claimedAt ?? parsed.enqueuedAt;
            const ageBasisMs = Date.parse(ageBasisIso);
            if (Number.isNaN(ageBasisMs)) {
              this.logger.warn(
                { workerId, itemKey, claimedAt: parsed.claimedAt, enqueuedAt: parsed.enqueuedAt },
                'Unparseable claim age timestamp in reapOrphanClaims, skipping',
              );
              continue;
            }
            const ageMs = now - ageBasisMs;
            // Refresh the enqueue-time cache from the claim payload — the
            // collision path's `hasInFlightAge` reads this instead of
            // re-scanning every drop (finding 7).
            const enqueuedAtMs = Date.parse(parsed.enqueuedAt);
            if (!Number.isNaN(enqueuedAtMs)) {
              this.enqueuedAtCache.set(itemKey, enqueuedAtMs);
            }

            // #1054 finding 9 — bump `reclaimCount`, NOT `attemptCount`.
            // `release()`'s dead-letter gate reads `attemptCount`; letting
            // infra events (cluster restart → heartbeat gone → reap) inflate
            // it would condemn blameless items after N restarts.
            const attemptCountBefore = parsed.attemptCount;
            const attemptCountAfter = attemptCountBefore;
            const reclaimCountBefore = parsed.reclaimCount ?? 0;
            const reclaimCountAfter = reclaimCountBefore + 1;
            const reclaimItem: SerializedQueueItem = {
              ...parsed,
              // attemptCount deliberately unchanged.
              reclaimCount: reclaimCountAfter,
              queueReason: 'resume',
              priority: resumePriority,
              // claimedAt is a claim-lifecycle field; strip it when re-pending
              // so the next claim stamps a fresh one.
              claimedAt: undefined,
            };
            const reclaimItemJSON = JSON.stringify(reclaimItem);

            let result: number;
            try {
              result = (await (this.redis as any).reclaimOrphan(
                claimedKey,
                heartbeatKey,
                PENDING_KEY,
                itemKey,
                String(ageMs),
                String(graceWindowMs),
                String(resumePriority),
                reclaimItemJSON,
              )) as number;
            } catch (error) {
              this.logger.warn(
                { err: error, workerId, itemKey },
                'Redis error in reapOrphanClaims (Lua), continuing sweep',
              );
              continue;
            }

            if (result === 1) {
              const reclaimed: ReclaimedItem = {
                workerId,
                itemKey,
                ageMs,
                attemptCountBefore,
                attemptCountAfter,
                reclaimCountBefore,
                reclaimCountAfter,
              };
              report.reclaimed.push(reclaimed);
              // FR-008: per-reclaim `warn` line. Not gated by transition-edge
              // tracking — the reclaim itself is one-shot. Complements the
              // in-memory reaper warn in worker-dispatcher.ts so log queries
              // can differentiate the two paths.
              this.logger.warn(
                {
                  event: 'orphan-claim-reclaimed',
                  workerId,
                  itemKey,
                  ageMs,
                  attemptCountBefore,
                  attemptCountAfter,
                  reclaimCountBefore,
                  reclaimCountAfter,
                  reason: 'orphaned-claim-no-heartbeat',
                },
                'Reclaimed orphaned queue claim (worker heartbeat absent)',
              );
              // Bound the transition-edge Map growth (R6).
              this.dropLogState.delete(itemKey);
            } else if (result === 2) {
              report.skippedRaceReappeared += 1;
            } else if (result === 3) {
              report.skippedGraceWindow += 1;
            }
            // result === 0 → no-op (already reclaimed by another dispatcher)
          }
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Redis error in reapOrphanClaims sweep, returning partial report',
      );
    }

    return report;
  }

  async enqueue(item: QueueItem): Promise<boolean> {
    this.ensureEnqueueCommand();
    const itemKey = buildItemKey(item);
    const priority = getPriorityScore(item.queueReason);
    const serialized: SerializedQueueItem = {
      ...item,
      priority,
      attemptCount: 0,
      itemKey,
    };

    try {
      const result = await (this.redis as any).enqueueItem(
        PENDING_KEY,
        IN_FLIGHT_KEY,
        `${DEDUP_KEY_PREFIX}${itemKey}`,
        itemKey,
        String(priority),
        JSON.stringify(serialized),
      );
      const enqueued = result === 1;
      if (enqueued) {
        // #1054 finding 7 — seed the enqueuedAt cache so subsequent drop-path
        // reads don't fan out into an O(workers) SCAN.
        const enqueuedAtMs = Date.parse(item.enqueuedAt);
        if (!Number.isNaN(enqueuedAtMs)) {
          this.enqueuedAtCache.set(itemKey, enqueuedAtMs);
        }
        this.logger.info(
          { owner: item.owner, repo: item.repo, issue: item.issueNumber, priority, itemKey },
          'Item enqueued to Redis sorted set (in-flight-checked)',
        );
        return true;
      }
      // #1060 / FR-005: in-flight-collision drop, mirrors enqueueIfAbsent's
      // transition-edge log path so both verbs emit the same shape.
      const ageMs = await this.hasInFlightAge(itemKey);
      const decision = classifyDropSeverity(
        itemKey,
        ageMs,
        this.maxRunDurationMs,
        this.dropLogState,
      );
      emitDropLog(
        this.logger,
        decision,
        { itemKey, source: 'enqueue', reason: 'in-flight', ageMs },
        'Dropping enqueue (item already in flight)',
      );
      return false;
    } catch (error) {
      this.logger.warn(
        { err: error, itemKey },
        'Redis error in enqueue, item not added to queue',
      );
      return false;
    }
  }

  async claim(workerId: string): Promise<QueueItem | null> {
    this.ensureClaimCommand();

    const pendingKey = PENDING_KEY;
    const claimedKey = buildClaimedKey(workerId);
    const heartbeatKey = buildHeartbeatKey(workerId);
    const ttlSeconds = Math.ceil(30000 / 1000); // Default; actual TTL managed by dispatcher's heartbeat refresh
    // #1054 finding 3 — stamp claimedAt so the reaper's grace-window
    // measures age-since-CLAIM (see CLAIM_SCRIPT docstring).
    const claimedAt = new Date().toISOString();

    try {
      const result = await (this.redis as any).claimItem(
        pendingKey,
        claimedKey,
        heartbeatKey,
        ttlSeconds,
        claimedAt,
      );

      if (!result) {
        return null;
      }

      const serialized: SerializedQueueItem = JSON.parse(result as string);
      this.logger.info(
        { workerId, itemKey: serialized.itemKey, attempt: serialized.attemptCount },
        'Item claimed from queue'
      );

      return {
        owner: serialized.owner,
        repo: serialized.repo,
        issueNumber: serialized.issueNumber,
        workflowName: serialized.workflowName,
        command: serialized.command,
        priority: serialized.priority,
        enqueuedAt: serialized.enqueuedAt,
        metadata: serialized.metadata,
        queueReason: serialized.queueReason,
      };
    } catch (error) {
      this.logger.warn(
        { err: error, workerId },
        'Redis error in claim, returning null'
      );
      return null;
    }
  }

  async release(workerId: string, item: QueueItem): Promise<void> {
    const itemKey = buildItemKey(item);
    const claimedKey = buildClaimedKey(workerId);
    const heartbeatKey = buildHeartbeatKey(workerId);

    try {
      // Get the claimed item to check attempt count
      const claimedRaw = await this.redis.hget(claimedKey, itemKey);
      let attemptCount = 0;
      if (claimedRaw) {
        const parsed: SerializedQueueItem = JSON.parse(claimedRaw);
        attemptCount = parsed.attemptCount + 1;
      }

      if (attemptCount >= this.maxRetries) {
        // Dead-letter: too many retries. Co-atomically remove from in-flight SET.
        const deadLetterItem: SerializedQueueItem = {
          ...item,
          attemptCount,
          itemKey,
        };
        await this.redis
          .multi()
          .hdel(claimedKey, itemKey)
          .del(heartbeatKey)
          .zadd(DEAD_LETTER_KEY, Date.now(), JSON.stringify(deadLetterItem))
          .srem(IN_FLIGHT_KEY, itemKey)
          .exec();
        // #1054 / R6: bound the transition-edge Map growth.
        this.dropLogState.delete(itemKey);
        // #1054 finding 7 — dead-letter fully removes the item from flight;
        // clear the enqueuedAt cache to bound growth alongside dropLogState.
        this.enqueuedAtCache.delete(itemKey);
        this.logger.warn(
          { workerId, itemKey, attemptCount, maxRetries: this.maxRetries },
          'Item dead-lettered after max retries'
        );
      } else {
        // Re-queue with retry priority. Item stays in in-flight SET (still in flight).
        const retryPriority = getPriorityScore('retry');
        const requeueItem: SerializedQueueItem = {
          ...item,
          queueReason: 'retry',
          priority: retryPriority,
          attemptCount,
          itemKey,
        };
        await this.redis
          .multi()
          .hdel(claimedKey, itemKey)
          .del(heartbeatKey)
          .zadd(PENDING_KEY, retryPriority, JSON.stringify(requeueItem))
          .exec();
        this.logger.info(
          { workerId, itemKey, attemptCount },
          'Item released back to pending queue'
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: error, workerId, itemKey },
        'Redis error in release'
      );
    }
  }

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
      // #1054 / R6: bound the transition-edge Map growth.
      this.dropLogState.delete(itemKey);
      // #1054 finding 7 — complete fully removes the item from flight;
      // clear the enqueuedAt cache to bound growth alongside dropLogState.
      this.enqueuedAtCache.delete(itemKey);
      this.logger.info(
        { workerId, itemKey },
        'Item completed and removed from claimed set + in-flight index'
      );
    } catch (error) {
      this.logger.warn(
        { err: error, workerId, itemKey },
        'Redis error in complete'
      );
    }
  }

  async getQueueDepth(): Promise<number> {
    try {
      return await this.redis.zcard(PENDING_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis error in getQueueDepth');
      return 0;
    }
  }

  async getQueueItems(offset: number, limit: number): Promise<QueueItemWithScore[]> {
    try {
      const results = await this.redis.zrange(
        PENDING_KEY,
        offset,
        offset + limit - 1,
        'WITHSCORES'
      );

      const items: QueueItemWithScore[] = [];
      // Results come as [member, score, member, score, ...]
      for (let i = 0; i + 1 < results.length; i += 2) {
        const member = results[i];
        const scoreStr = results[i + 1];
        if (!member || !scoreStr) continue;
        const serialized: SerializedQueueItem = JSON.parse(member);
        const score = parseFloat(scoreStr);
        items.push({
          item: {
            owner: serialized.owner,
            repo: serialized.repo,
            issueNumber: serialized.issueNumber,
            workflowName: serialized.workflowName,
            command: serialized.command,
            priority: serialized.priority,
            enqueuedAt: serialized.enqueuedAt,
            metadata: serialized.metadata,
            queueReason: serialized.queueReason,
          },
          score,
        });
      }

      return items;
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis error in getQueueItems');
      return [];
    }
  }

  async getActiveWorkerCount(): Promise<number> {
    try {
      // Scan for all claimed hash keys and sum their lengths
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, matchedKeys] = await this.redis.scan(
          cursor,
          'MATCH',
          `${CLAIMED_KEY_PREFIX}*`,
          'COUNT',
          100
        );
        cursor = nextCursor;
        keys.push(...matchedKeys);
      } while (cursor !== '0');

      let count = 0;
      for (const key of keys) {
        count += await this.redis.hlen(key);
      }
      return count;
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis error in getActiveWorkerCount');
      return 0;
    }
  }
}
