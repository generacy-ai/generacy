# Quickstart — #1058 Periodic in-flight/claim reconciliation

## What this fix does

Automatically un-wedges `orchestrator:queue:in-flight-items` members that have no matching pending or claim entry. Closes the residue gap called out by the reviewer of PR #1056 (finding 6): a claim hash evicted by Redis memory pressure, an out-of-band operator `DEL`, or a future bug that `HDEL`s without a paired `SREM` all leave an itemKey stranded in the in-flight SET, and every subsequent `enqueueIfAbsent` for that issue is silently dropped by `SISMEMBER`. Post-fix, a two-sweep reconciliation pass in the orchestrator's `reaperLoop` detects and repairs the residue automatically.

Complements PR #1056 (`RECLAIM_ORPHAN_SCRIPT` — claim-side sweep for heartbeat-absent workers) and PR #1065 (`ENQUEUE_SCRIPT` co-atomicity — primary intake path). Together the three make the `in-flight = pending ∪ claimed` invariant self-repairing rather than only assertion-based.

## What changes for operators

1. **Residue auto-recovers within ≤ 3 × `heartbeatCheckIntervalMs`** (default 90 s: one cycle to observe, one to confirm, one for cycle-boundary safety). With the boot sweep, residue present at process start is repaired in ~30 s (boot sweep arms + first regular sweep confirms). Before: residue required manual `redis-cli SREM orchestrator:queue:in-flight-items <itemKey>` intervention.
2. **Two new log events**:
   - `event: "orphan-in-flight-reconciled"` (`warn`) — fires once per successful `SREM`. Payload: `{ itemKey, ageMs, reason: "in-flight-no-pending-no-claim" }`.
   - `event: "reconcile-in-flight"` (`info`) — fires once per reaper cycle when `reconciled > 0 || skippedRaceReappeared > 0 || trackedFirstSeen > 0`. Payload: `{ scanned, reconciled, skippedRaceReappeared, trackedFirstSeen }`. Silent for healthy cycles.
3. **New log event under high residue volume**: `event: "orphan-in-flight-reconciled-batch"` (`warn`) — fires once per cycle if >100 individual reconciled warns would have been emitted. Payload: `{ count, sampledItemKeys: [<first 10>] }`.
4. **Debug event for tracker inserts** (usually silent unless log level = debug): `event: "orphan-in-flight-tracked"` — fires once per first-sweep observation. Payload: `{ itemKey, firstSeenSweepId }`. Useful for observing a wedge being tracked before repair.
5. **No new config knobs.** Reconciliation shares the reaperLoop's `heartbeatCheckIntervalMs` cadence.

## What does NOT change

- `CLAIM_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`, `RELEASE_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`, `REQUEUE_FOR_RESUME_SCRIPT`, `release()`, `complete()`, `handleLeaseExpired`, `reapOrphanClaims` (behavior — only its docstring updates per FR-007). Additive fix per FR-006. Zero change to hot-path ops.
- Existing `reapStaleWorkers` / `reapOrphanClaims` continue to run on the same cadence.
- Dead-letter behavior — reconciliation only removes the residue from `IN_FLIGHT_KEY`; it does not touch pending, claimed, or dead-letter data structures.
- No env var name change; no schema change (uses existing `heartbeatCheckIntervalMs`).

## Configuration

No new configuration required. `heartbeatCheckIntervalMs` (existing on `DispatchConfigSchema`, default 30 s per current schema) governs the reconciliation cadence. Raising it slows reconciliation proportionally.

If observed reconciliation activity is high on a cluster (steady stream of `orphan-in-flight-reconciled` warns), investigate the underlying cause — one of:

- Redis `maxmemory-policy` is set to a policy that evicts hash fields (e.g., `allkeys-lru` with high memory pressure). Consider `noeviction` or a policy that spares queue-adapter hashes.
- A recent code change introduced an unpaired `HDEL` on `orchestrator:queue:claimed:*` without a matching `SREM IN_FLIGHT_KEY`. Grep for `HDEL orchestrator:queue:claimed` outside `RECLAIM_ORPHAN_SCRIPT`/`RELEASE_SCRIPT`/`REQUEUE_FOR_RESUME_SCRIPT`/`complete()`.
- Operator ran `redis-cli DEL orchestrator:queue:in-flight-items` (the 2026-07-28 15:18Z tetrad-development incident). Expected to be rare post-fix — reconciliation auto-repairs.

## Log queries

### "Show me currently-repaired residue"

```
event: "orphan-in-flight-reconciled"
```

Fires once per reclaim `SREM`. If this line appears frequently, investigate the underlying source per the Configuration section above.

### "Alert on high-volume reconciliation events"

```
event: "orphan-in-flight-reconciled-batch"
```

Fires once per cycle only when >100 individual reconciled events would have been emitted. Presence indicates a large-scale residue event — a regression, a mass eviction, or a manual mass-`DEL`. Investigate immediately.

### "Reaper cycle summary (sanity check)"

```
event: "reconcile-in-flight"
```

Fires once per reaper cycle when nonzero (`reconciled + skippedRaceReappeared + trackedFirstSeen > 0`). Silence for a fully-healthy cluster is expected — the reaper still runs, just doesn't log.

### "Observe wedges being tracked (debug)"

```
event: "orphan-in-flight-tracked"
```

Debug-level. Fires once per first-sweep observation. Useful for confirming the tracker is arming candidates as expected during triage.

### Composite: "queue self-repair activity"

```
event: "orphan-claim-reclaimed" OR event: "orphan-in-flight-reconciled"
```

Combines the sibling `reapOrphanClaims` reclaim event (claim-side) with this fix's reconciliation event (SET-side) — the union captures every automatic queue-integrity repair.

## Running tests

```bash
# Full orchestrator test suite (recommended — includes the new integration regression):
pnpm --filter @generacy-ai/orchestrator test

# Just the new integration suite (requires the CI-provided redis:7 service; see
# packages/orchestrator/vitest.config.integration.ts for the harness):
pnpm --filter @generacy-ai/orchestrator test:integration -- reconcile-in-flight

# Cross-adapter parity assertion:
pnpm --filter @generacy-ai/orchestrator test -- queue-adapter-parity

# Script-wiring static assertion:
pnpm --filter @generacy-ai/orchestrator test -- redis-queue-adapter.script-wiring
```

## Manual verification (in a live cluster with Redis)

Reproduce the wedge shape from the 2026-07-28 15:18Z tetrad-development incident:

```bash
# 1. Trigger a claim (e.g., label an issue to be picked up by a monitor).

# 2. Verify the wedge state is reproducible via operator DEL:
redis-cli KEYS 'orchestrator:queue:claimed:*'
# → orchestrator:queue:claimed:<UUID>

redis-cli SMEMBERS 'orchestrator:queue:in-flight-items'
# → includes "owner/repo#N"

# 3. Simulate the residue class of failure:
redis-cli HDEL orchestrator:queue:claimed:<UUID> owner/repo#N
# (in-flight SET retains "owner/repo#N"; claim hash no longer has it)

# 4. Verify pre-fix behavior: enqueueIfAbsent is silently dropped:
#    (Trigger any monitor path that would enqueue for owner/repo#N — the
#     orchestrator info log will show "Dropping enqueueIfAbsent (item already in flight)")

# 5. Wait ≤ 3 × heartbeatCheckIntervalMs (default 90 s) for the two-sweep reconciliation.

# 6. Verify the SREM happened:
redis-cli SMEMBERS 'orchestrator:queue:in-flight-items'
# → no longer includes "owner/repo#N"

# 7. Check logs for the `event: "orphan-in-flight-reconciled"` line.

# 8. Trigger the monitor again; the enqueue now succeeds.
```

## Rollback

Revert the changeset PR. The fix is purely additive; the existing paths are untouched (FR-006). No data migration; nothing on disk / in Redis needs cleanup after a revert. Residue pre-existing before the revert stays wedged and requires manual intervention (as before this fix).

## Troubleshooting

- **`event: "orphan-in-flight-reconciled"` never appears, but items still wedge.** Check that the dispatcher's `reaperLoop` is running (`orchestrator` container healthy). Check Redis reachability (`redis-cli PING`). Check that the wedged itemKey is genuinely orphaned: `redis-cli SISMEMBER orchestrator:queue:in-flight-items <itemKey>` should return 1 AND no `orchestrator:queue:claimed:*` hash should have `<itemKey>` as a field AND `orchestrator:queue:pending` should have no member with matching `itemKey`.
- **`event: "reconcile-in-flight"` shows `skippedRaceReappeared` on every cycle for the same itemKey.** A concurrent enqueue path is racing with reconciliation. Under normal operation this should self-resolve — the next cycle either confirms and repairs, or drops from the tracker. If persistent (>10 cycles for the same itemKey), investigate whether a monitor is repeatedly attempting to `enqueueIfAbsent` for a wedged item while a bug elsewhere keeps the wedge state consistent (unusual).
- **`orphan-in-flight-reconciled` fires for items you expected to still be live.** Impossible under the two-sweep gate + atomic Lua re-check if the item is genuinely live. Investigate via `redis-cli MONITOR` during the incident: confirm the sequence `SISMEMBER` returned 1 immediately before `SREM`, and that the item was truly absent from both pending and claimed at both sweep observations (~30 s apart).
- **Post-`SREM`, `enqueueIfAbsent` still returns false.** Suggests either (a) a second wedge produced the itemKey again before your test ran (check for concurrent triggers), or (b) `enqueuedAtCache` retention (should not happen per AD-6 — file a bug). Force-clear: restart the dispatcher, which resets in-memory state.
- **Wedges pre-existing before the fix deployed take ≥30 s to repair.** Expected. The boot sweep arms candidates at process start; the first regular sweep repairs at `t=heartbeatCheckIntervalMs`. Under the default 30 s cadence, the first repair fires ~30 s after startup.
