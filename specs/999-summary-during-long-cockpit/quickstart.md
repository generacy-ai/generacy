# Quickstart: Shared quiet-horizon for `EpicEventBus` + `event-bus-registry`

**Issue**: [#999](https://github.com/generacy-ai/generacy/issues/999)
**Branch**: `999-summary-during-long-cockpit`

## What this feature does

Eliminates `resetFrom:"discarded"` / `"expired"` cursor recoveries during long `/cockpit:auto` runs by:

1. Extending both the `event-bus-registry` idle-TTL and the `EpicEventBus` buffer retention window from **10 minutes to 120 minutes**.
2. Expressing both horizons as **one shared exported constant** (`DEFAULT_QUIET_HORIZON_MS`), so the two can't silently desync in the future.

Behaviour after the fix, in one sentence: an operator's `cockpit_await_events` cursor stays `valid` across quiet phases up to 120 minutes long, and the auto skill no longer re-runs a full startup sweep in that window.

## Install / build

Nothing to install operationally. Standard workflow:

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
```

## Usage — no CLI or API surface change

The MCP tools `cockpit_await_events` / `cockpit_status` / etc. are unchanged. The auto skill continues to call them as before. What changes is that they now succeed more often.

## Ops tuning (existing env vars — unchanged names)

The two horizons can still be tuned at process start via existing env vars:

```bash
# Registry idle-TTL for refcount-0 buses (default 7_200_000 = 120 min after this fix).
COCKPIT_MCP_BUS_IDLE_TTL_MS=3600000  # e.g. force back to 60 min

# Bus in-memory buffer retention window (default 7_200_000 = 120 min after this fix).
COCKPIT_MCP_EVENT_RETENTION_MS=3600000

# Memory bound on buffer entries per bus (unchanged; still 10_000).
COCKPIT_MCP_EVENT_RETENTION_COUNT=10000

# Registry LRU cap on live buses (unchanged; still 100).
COCKPIT_MCP_BUS_MAX=100
```

**Note**: to keep the two horizons in lockstep at runtime, set `COCKPIT_MCP_BUS_IDLE_TTL_MS` and `COCKPIT_MCP_EVENT_RETENTION_MS` to the **same** value. The single-shared-constant fix only guarantees lockstep for the defaults; ops overrides are independent by design (preserving the pre-#999 tuning contract).

## Verifying the fix locally

### Behavioural check — the direct signal

Run `/cockpit:auto` against a long epic with 30–60 min quiet phases and inspect the resulting ledger totals. Before this fix (or with `COCKPIT_MCP_BUS_IDLE_TTL_MS=600000` set), you'll see:

```
cursor-recovery discarded: N   # N > 0 for long-quiet runs
```

After this fix (defaults), you should see:

```
cursor-recovery discarded: 0
cursor-recovery expired: 0
```

for the actively-watched epic across the run's longest quiet phase.

### Unit-test check — no wall-clock wait needed

```bash
pnpm --filter @generacy-ai/generacy test -- event-bus
```

Two new cases in `__tests__/event-bus.test.ts` assert the constant value and the bus's default derivation. Two new cases in `__tests__/event-bus-registry.test.ts` cover the survival (FR-008(a)) and reclaim (FR-008(b)) paths using fake timers plus injected horizons.

## Troubleshooting

### "I still see `cursor-recovery discarded` on a fresh run"

The classification's `reason` field distinguishes the case:

- `evicted` — bus idle-TTL fired OR buffer was time-trimmed. This is the case #999 addresses. If you see this on a run whose quiet phases are <120 min, check: `process.env.COCKPIT_MCP_BUS_IDLE_TTL_MS` might be overriding the default to a smaller value.
- `cross-instance` — the MCP server process restarted. Out of scope for #999. Check MCP server uptime.

### "The cursor recovery is `resetFrom:"expired"` instead of `"discarded"`"

Two sub-cases:

- Buffer time-trim (10-min in old code) — addressed by this fix; won't happen within 120 min.
- Buffer count-trim (>10_000 events in the window) — accepted residual per FR-005 / C-004. Extremely unlikely at cockpit's per-epic granularity (~83 events/min for 2h is implausible). If it happens in practice, raise `COCKPIT_MCP_EVENT_RETENTION_COUNT` (memory-bound axis, separate from time-horizon).

### "Memory usage on the MCP server crept up after the fix"

Idle buses now linger for 120 min instead of 10 min before being reclaimed by the idle-TTL timer. Each bus is memory-bounded by `retentionCount = 10_000` × ~1 KB/event and the registry is bounded by `maxBuses = 100` LRU eviction. If you see steady-state growth beyond ~1 GB, check:

- Whether `maxBuses` is being hit (structured log `event-bus: LRU eviction of ...` should fire).
- Whether idle-TTL is firing (`event-bus: idle-TTL eviction of ...` should fire ~120 min after the last release).

Neither should be common — idle epics still get reclaimed, just on a wider window.

## Related work

- **#997** — Doorbell survives smee loss + quiet windows. Same "long quiet phase in `/cockpit:auto`" family; complementary but independent.
- **#978** — Event-bus origin.
- **#985** — Content-ful NDJSON events on the doorbell; enables the future cheaper-recovery path (spec Out-of-Scope §2).
