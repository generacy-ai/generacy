# Contract — `QueueManager` interface additions

Load-bearing invariant for FR-005 (cross-adapter parity). Both `RedisQueueAdapter` and `InMemoryQueueAdapter` must implement the new method.

## Interface diff

Location: `packages/orchestrator/src/types/monitor.ts`

Add one method to `QueueManager` (co-located with `reapOrphanClaims` around `:398`):

```ts
export interface QueueManager extends QueueAdapter {
  // ... existing members (claim, release, requeueForResume, complete,
  // getQueueDepth, getQueueItems, getActiveWorkerCount, enqueueIfAbsent,
  // hasInFlight, reapOrphanClaims, hasInFlightAge) ...

  /**
   * #1058 / FR-001: reconciliation sweep for `orchestrator:queue:in-flight-items`
   * members that have no matching pending or claim entry (the residue class of
   * failure that `reapOrphanClaims` cannot see — its sweep is candidate-set-
   * driven from `claimed:*` keys). Runs on the dispatcher's reaper cadence
   * immediately after `reapOrphanClaims` (AD-5), plus one boot sweep at
   * process start (Q2=B).
   *
   * Two-sweep confirmation gate (Q1=D): a residue candidate must be observed
   * as residue in two consecutive sweeps before removal. Cross-sweep state
   * lives in an in-memory `Map<itemKey, firstSeenSweepId>` on the adapter.
   * First-sweep observations log at `debug`; second-sweep confirmations
   * invoke `RECONCILE_IN_FLIGHT_SCRIPT` (single-key atomic `SISMEMBER`+`SREM`).
   *
   * On successful `SREM`: `enqueuedAtCache.delete(itemKey)` AND
   * `dropLogState.delete(itemKey)` fire (AD-6 / Q3=C — full cleanup matches
   * `complete()`, dead-letter, and successful reclaim semantics).
   *
   * Never throws. On transport error mid-sweep: `warn` + returns partial
   * report so subsequent cycles retry.
   *
   * @param now epoch-ms; parameterized for testability (default `Date.now()`)
   */
  reconcileInFlight(now?: number): Promise<ReconcileReport>;
}
```

## New exported type

```ts
/**
 * #1058 — aggregate result of one `reconcileInFlight` sweep. Consumed by
 * `WorkerDispatcher.reaperLoop`'s per-cycle log line (info when nonzero).
 * Log gate: `reconciled > 0 || skippedRaceReappeared > 0 || trackedFirstSeen > 0`.
 * A fully healthy cycle produces zero log lines.
 */
export interface ReconcileReport {
  /** Number of `IN_FLIGHT_KEY` members examined via `SSCAN`. */
  scanned: number;
  /**
   * Number of `SREM`s successfully issued this cycle (post two-sweep
   * confirmation, post-Lua atomic re-check). Each corresponds to exactly
   * one `orphan-in-flight-reconciled` warn line (or contributes to the
   * aggregate line if `RECONCILE_LOG_CAP` is exceeded).
   */
  reconciled: number;
  /**
   * Confirmed residue candidates whose `RECONCILE_IN_FLIGHT_SCRIPT` returned
   * `0` (SISMEMBER == 0 — item was already gone or re-added by a concurrent
   * `enqueueIfAbsent`/`enqueue` between the client-side residue computation
   * and the Lua invocation). Tracker entry retained; next sweep re-evaluates.
   */
  skippedRaceReappeared: number;
  /**
   * Number of itemKeys inserted into `reconcileTracker` this cycle
   * (first-sweep observations). These will be re-evaluated on the next
   * sweep; if still residue, they graduate to `reconciled` (or
   * `skippedRaceReappeared` on Lua race). If they re-appear in
   * pending/claimed before then, they are silently dropped from the
   * tracker (transient race artifact self-clear).
   */
  trackedFirstSeen: number;
}
```

## Adapter implementation contracts

### `RedisQueueAdapter.reconcileInFlight(now = Date.now())`

Public method. Implementation shape:

1. Increment `this.reconcileSweepCounter`. Local `sweepId` = the incremented value.
2. Ensure Lua command registration via `ensureReconcileInFlightCommand()`.
3. Snapshot phase (client-side, all reads under a single `try` for FR-004 error-tolerance):
   - `SSCAN IN_FLIGHT_KEY` batches with `COUNT 100` → build `inFlightSet: Set<string>`.
   - `ZRANGE PENDING_KEY 0 -1` → JSON.parse each → build `pendingSet: Set<string>`.
   - `SCAN CLAIMED_KEY_PREFIX*` with `COUNT 100` → `HKEYS` per hash → build `claimedSet: Set<string>`.
4. Compute residue in memory: `residue = inFlightSet \ (pendingSet ∪ claimedSet)`.
5. Two-sweep gate:
   - For each `itemKey` in `residue`:
     - If not in `reconcileTracker`: insert `{ itemKey → sweepId }`, log `debug` (`orphan-in-flight-tracked`), increment `report.trackedFirstSeen`.
     - Else (tracker holds a `firstSeenSweepId < sweepId`): invoke `RECONCILE_IN_FLIGHT_SCRIPT` via `(this.redis as any).reconcileInFlightItem(IN_FLIGHT_KEY, itemKey)`.
       - On `1` (reconciled): increment `report.reconciled`; delete tracker entry; delete `enqueuedAtCache[itemKey]`; delete `dropLogState[itemKey]`; emit `warn` (subject to `RECONCILE_LOG_CAP`).
       - On `0` (skipped): increment `report.skippedRaceReappeared`; retain tracker entry.
       - On throw: `warn` (Lua error), continue to next candidate.
   - For each `itemKey` in `reconcileTracker` NOT in `residue`: delete tracker entry (transient race artifact self-clear).
6. FR-004 log cap accounting: track `emittedCount` per cycle. When `emittedCount > RECONCILE_LOG_CAP`, buffer subsequent itemKeys into a suppressed-list and emit one aggregate `orphan-in-flight-reconciled-batch` at cycle end with `{ event, count: suppressed.length, sampledItemKeys: suppressed.slice(0, 10) }`.
7. Return the `ReconcileReport`. Never throw.

Error tolerance: any transport error during snapshot phase (`SSCAN`/`ZRANGE`/`SCAN`/`HKEYS`) logs `warn` and returns whatever partial `report` has been assembled. Per-candidate Lua errors log `warn` and continue the sweep — the item stays in the tracker; next cycle re-attempts.

### `InMemoryQueueAdapter.reconcileInFlight(_now?)` — no-op

Public method. Implementation:

```ts
/**
 * #1058 / FR-005 — no-op for the in-memory adapter. In-memory `pending`,
 * `claimed`, and `inFlightSet` are first-class fields in the same process
 * that cannot diverge without a bug in this class (caught by
 * `in-memory-queue-adapter.enqueue-invariant.test.ts` and siblings).
 * Returns an empty report so `WorkerDispatcher.reaperLoop` can call this
 * unconditionally without a Redis-vs-in-memory branch.
 */
async reconcileInFlight(_now?: number): Promise<ReconcileReport> {
  return {
    scanned: this.inFlightSet.size,
    reconciled: 0,
    skippedRaceReappeared: 0,
    trackedFirstSeen: 0,
  };
}
```

`scanned` returns the size rather than 0 so a call site logging `scanned` sees a truthful "sweep did look at the set" signal.

## Cross-adapter parity contract

Enforced by `packages/orchestrator/src/services/__tests__/queue-adapter-parity.test.ts` — parameterized `describe.each` block:

```ts
describe.each([
  ['redis', () => setupRedisAdapter()],
  ['in-memory', () => setupInMemoryAdapter()],
])('reconcileInFlight parity (%s)', (adapterName, setup) => {
  it('exists and returns a ReconcileReport shape', async () => {
    const { adapter } = await setup();
    const report = await adapter.reconcileInFlight();
    expect(report).toEqual(
      expect.objectContaining({
        scanned: expect.any(Number),
        reconciled: expect.any(Number),
        skippedRaceReappeared: expect.any(Number),
        trackedFirstSeen: expect.any(Number),
      })
    );
  });

  it('healthy-state cycle produces zero reconciled', async () => {
    const { adapter } = await setup();
    await adapter.enqueueIfAbsent(item1);
    const worker = await adapter.claim('worker-1');
    if (worker) await adapter.complete('worker-1', worker);
    const report = await adapter.reconcileInFlight();
    expect(report.reconciled).toBe(0);
  });
});
```

Wedge-repair (SC-001) is Redis-only — the in-memory adapter cannot produce a wedge by construction, so the wedge-repair assertion lives in the Redis-specific integration test only.

## Semver impact

- `QueueManager.reconcileInFlight` is added to the interface. Any implementation of `QueueManager` outside the orchestrator package must add the method. `pnpm why @generacy-ai/orchestrator` reports which packages consume the type; verify at implement time.
- Currently only `RedisQueueAdapter` and `InMemoryQueueAdapter` implement `QueueManager`, and both are internal to `@generacy-ai/orchestrator`. Bump `patch`.
- If a future PR re-exports `QueueManager` from `packages/orchestrator/src/index.ts` and an external consumer adds a mock implementation, escalate to `minor` at that point.
