# Quickstart — #1054 Orphaned queue claims must be reclaimed after a worker dies without unwinding

## What this fix does

Automatically reclaims Redis queue claims left behind when a worker process dies without unwinding (SIGKILL, container OOM, dispatcher replacement). Prevents the 84-minute silent stall observed on `generacy-ai/generacy#1051`, and makes the wedge visible in log queries with a single `warn` line on the transition edge.

## What changes for operators

1. **Wedges auto-recover within ≤ 45s** (default `heartbeatTtlMs` 30s + `heartbeatCheckIntervalMs` 15s + reclaim latency). Before: wedges required manual `redis-cli DEL orchestrator:queue:claimed:*` intervention.
2. **First `warn` log fires 30 min into a stalled entry** (default `maxRunDurationMs`). Query alerts on `severity: "warn" AND message: "Dropping ... enqueue (item already in flight)"` or `event: "orphan-claim-reclaimed"`. See [Log queries](#log-queries).
3. **New config knob** `maxRunDurationMs` on `DispatchConfigSchema`. Default 30 min. Operators with legitimately longer runs can raise the threshold without a code change.
4. **Per-reclaim `warn` line** `Reclaimed orphaned queue claim (worker heartbeat absent)` includes `{ workerId, itemKey, ageMs, attemptCountBefore, attemptCountAfter }`. Distinguishable from the existing in-memory reaper's `Reaping stale worker (heartbeat expired)` line by the `event: "orphan-claim-reclaimed"` field.

## What does NOT change

- `CLAIM_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`, `release()`, `complete()`, `handleLeaseExpired` — additive fix per FR-010. Zero change to hot-path ops (SC-007).
- Existing in-memory `reapStaleWorkers` path — still runs on the dispatcher's cadence, still covers the subset of workers this dispatcher owns.
- Dead-letter behaviour — reclaim increments `attemptCount` but never dead-letters. Dead-lettering stays on the `release()` failure path (Q3=C).
- No new env var name. `maxRunDurationMs` picks up its env override through the existing `config/loader.ts` pipeline.

## Configuration

`.generacy/config.yaml` (or the equivalent config file):

```yaml
dispatch:
  # ... existing fields ...
  maxRunDurationMs: 1800000    # default: 30 min. Raise for legitimately long runs.
```

Or via env: whatever the loader binds `DispatchConfig.maxRunDurationMs` to (typically `ORCHESTRATOR_DISPATCH_MAX_RUN_DURATION_MS` or the analogous form).

Recommended thresholds:
- Default (30 min) — appropriate for speckit-feature clusters where the pathological case is the 20-min CLI timeout + partial-push overhead.
- 60 min — clusters with occasional very-large-PR fixer runs. Trade-off: a legitimate 45-min run doesn't emit a `warn`; a wedge sits silent longer.
- **Never below 20 min** — the CLI timeout itself is 20 min, so a lower threshold produces `warn`s on healthy runs.

## Log queries

### "Show me currently-wedged items"

```
event: "orphan-claim-reclaimed"
```

Fires once per reclaim. If this line appears frequently, investigate worker-death root cause (out-of-scope for this fix — see spec §Out of Scope).

### "Alert on items stalled past the run-duration threshold"

```
severity: "warn" AND message: "Dropping"
```

Fires once when an in-flight entry crosses 30 min age. Suppressed for repeat cycles of the same itemKey (SC-004 transition-edge semantic). Fires again on the transition back to healthy (severity flips info).

### "Reaper is running (sanity check)"

```
event: "reap-orphan-claims"
```

Fires once per reaper cycle when nonzero (any of `reclaimed`, `skippedRaceReappeared`, `skippedGraceWindow` > 0). Silence for a fully-healthy cluster is expected — the reaper still runs, just doesn't log.

## Running tests

```bash
# Full orchestrator test suite (recommended — includes the new orphan-reclaim regression):
pnpm --filter @generacy-ai/orchestrator test

# Just the new regression suite:
pnpm --filter @generacy-ai/orchestrator test -- redis-queue-adapter.orphan-reclaim

# Just the drop-log helper unit tests:
pnpm --filter @generacy-ai/orchestrator test -- drop-log-helper
```

## Manual verification (in a live cluster with Redis)

Reproduce the wedge shape from `generacy-ai/generacy#1051`:

```bash
# 1. Trigger a claim (e.g. label an issue to be picked up by a monitor).

# 2. In another shell, get the workerId:
redis-cli KEYS 'orchestrator:queue:claimed:*'
# → orchestrator:queue:claimed:<UUID>

# 3. Simulate a killed worker: delete the heartbeat:
redis-cli DEL orchestrator:worker:<UUID>:heartbeat

# 4. Wait ≤ 15s (one heartbeatCheckIntervalMs) for the reaper to fire.

# 5. Verify the reclaim happened:
redis-cli KEYS 'orchestrator:queue:claimed:*'
# → (should no longer include <UUID>)

redis-cli SMEMBERS 'orchestrator:queue:in-flight-items'
# → (should no longer include the itemKey — or, if a new worker has re-claimed, contains it again with a new workerId)

# 6. Check logs for the `event: "orphan-claim-reclaimed"` line.
```

## Rollback

Revert the changeset PR. The fix is purely additive; the existing paths are untouched (FR-010). No data migration; nothing on disk / in Redis needs cleanup after a revert. Wedges pre-existing before the revert stay wedged and require manual intervention (as before this fix).

## Troubleshooting

- **`event: "orphan-claim-reclaimed"` never appears, but items still wedge.** Check that the dispatcher is running (`docker compose ps orchestrator` or equivalent). Check that Redis is reachable (`redis-cli PING`). Check that the workerId in the claim hash actually has no matching heartbeat (`redis-cli EXISTS orchestrator:worker:<UUID>:heartbeat`).
- **Every reclaim shows `skippedRaceReappeared` in the per-cycle log.** Suggests heartbeats are flapping — workers being SIGSTOP'd or paused. Look at cluster-side scheduling / cgroup limits.
- **Reclaim fires but the item never gets re-claimed by a new worker.** The item is at priority 0 (`queueReason: 'resume'`) in the pending set. If `claim()` isn't picking it up, the pending set may be empty of higher-priority work but no worker is polling — check `WorkerDispatcher.isRunning()` and lease-manager state.
- **`warn` line fires on healthy runs.** `maxRunDurationMs` is set too low. Raise to 60 min or higher.
