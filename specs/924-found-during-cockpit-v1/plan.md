# Implementation Plan: cockpit_await_events — bus survives between calls; cursors typed by lifetime

**Feature**: Fix `cockpit_await_events` sequential-cursor reuse; decouple bus lifetime from call lifetime; type cursors by lifetime (instance nonce + idle-TTL + soft cap)
**Branch**: `924-found-during-cockpit-v1`
**Issue**: [#924](https://github.com/generacy-ai/generacy/issues/924)
**Status**: Complete

## Summary

The MCP `cockpit_await_events` tool tears down its per-epic bus in a `finally` block on every call. For a sequential auto-mode session (one caller at a time) this drops refcount to 0 between every call, `event-bus-registry.releaseKey` invokes `sub.stop(); registry.delete(key)`, and the next call rebuilds a fresh bus whose `nextCursor` restarts at 1. Any cursor from the prior call now classifies as `never-issued` — a fail-loud caller-bug class — even though the caller did nothing wrong. The session degrades to a per-batch recovery sweep, erasing the dispatch-round win the tool exists to deliver.

This plan decouples bus lifetime from individual call lifetime by moving the bus registry to a **per-process, idle-TTL-scoped** lifecycle, and by embedding a **per-process instance nonce** in the cursor token so a bus that no longer exists (TTL eviction, LRU eviction, process restart) classifies as `discarded` (silent reset with `resetFrom`), not `never-issued`.

Five concrete changes, all inside `packages/generacy/src/cli/commands/cockpit/mcp/`:

1. **`event-bus-registry.ts`** — `releaseKey` no longer stops the poller or deletes the bus at refcount 0; instead it arms an idle-TTL timer. Timer disarms on next `acquire`. TTL default `600_000 ms`, env `COCKPIT_MCP_BUS_IDLE_TTL_MS`. LRU soft cap default 100, env `COCKPIT_MCP_BUS_MAX`; on-cap eviction picks least-recently-active bus.
2. **`event-bus.ts`** — every bus now holds a **per-process instance nonce** (generated once at module load via `crypto.randomBytes(8).toString('hex')`). `encodeCursor(epic, position)` becomes `encodeCursor(epic, position, nonce)`. `decodeCursor` returns `{ epic, position, nonce? }`. `parseCursor` gains a fourth branch (`discarded`) covering (a) missing nonce (legacy), (b) mismatched nonce (cross-instance), (c) reserved-for-future TTL/LRU eviction (evicted-bus reconstitutions carry a fresh nonce, so same-key-different-nonce naturally maps to `discarded`).
3. **`tools/cockpit_await_events.ts`** — new switch branch for `discarded` cursor kind maps to `resetFrom: 'discarded'` + start-of-buffer read (mirrors `expired` path). Existing `never-issued` branch preserved for genuine caller bugs (same-instance out-of-range).
4. **Poller pause on refcount 0** — `runPollLoop` gains a paused-state flag flipped by registry hooks; while paused it holds its `prev: SnapshotMap` and `aggState: AggregateState` but does not tick. On next `acquire` the registry calls a one-shot catch-up poll (single `runOnePoll` + `computeAggregateEvents`) synchronously before returning the acquired handle, so the caller sees every change that occurred while no one was listening.
5. **`schemas.ts`** — no wire-shape changes to the tool input schema. `resetFrom` on the output data becomes a union: `'expired' | 'discarded'`.

The wire shape of the cursor token stays base64(JSON), but the JSON payload gains an optional `nonce` field. Legacy cursors (no `nonce`) classify as `discarded` (Q3-A).

## Technical Context

- **Language**: TypeScript strict-mode, ESM, Node ≥22.
- **Package**: `@generacy-ai/generacy` (`packages/generacy/`) — modified only.
- **Test framework**: Vitest (existing project runner).
- **Dependencies**: no new npm deps; uses `node:crypto` (already an implicit dep across the codebase) for the per-process nonce.
- **Env vars added**:
  - `COCKPIT_MCP_BUS_IDLE_TTL_MS` — default `600_000`, controls FR-002 idle-TTL. Matches existing `COCKPIT_MCP_EVENT_RETENTION_*` idiom.
  - `COCKPIT_MCP_BUS_MAX` — default `100`, controls FR-007 soft cap.

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. Skipped.

## Project Structure

### Files modified

```
packages/generacy/src/cli/commands/cockpit/mcp/
├── event-bus.ts                              # nonce field, encode/decode/parseCursor, `discarded` class
├── event-bus-registry.ts                     # idle-TTL, LRU soft cap, poller pause/resume, catch-up hook
├── tools/cockpit_await_events.ts             # switch branch for `discarded`, resetFrom union
├── schemas.ts                                # (only if `resetFrom` shape needs an exported enum)
└── __tests__/
    ├── event-bus.test.ts                     # extended: nonce round-trip, `discarded` kind
    ├── await-events-cursor-classes.test.ts   # extended: discarded resetFrom
    └── event-bus-registry.test.ts            # NEW: registry lifecycle tests
```

### Files not touched

- `packages/generacy/src/cli/commands/cockpit/mcp/tools/*.ts` (except `cockpit_await_events.ts`) — no changes.
- `packages/generacy/src/cli/commands/cockpit/watch/*.ts` — reused (`runOnePoll`, `computeAggregateEvents`, `SnapshotMap`, `AggregateState`) unchanged.
- `packages/cockpit/*` — unchanged.

### stack.md

Per `CLAUDE.md`, `specs/<feature>/stack.md` documents per-feature stack notes. Created alongside plan.md.

## Key Design Decisions

### D1: Nonce lives in cursor payload, not out-of-band

**Decision**: Embed the nonce in the same JSON payload as `epic` + `position`, keeping the base64 wrapper.

**Rationale**: The wire shape stays a single opaque token — no separate header, no schema version field. Legacy cursors (no `nonce` field on decode) become a natural first-class discriminant for the `discarded` class (Q3-A), which is exactly what the spec calls for.

**Alternatives considered**:
- Add a `v` (schema version) field alongside `nonce` (Q3-D) — buys nothing the nonce doesn't already provide, since missing nonce *is* the v1 discriminant.
- Prefix the base64 with a plaintext instance identifier — leaks server identity into the token surface, no benefit.

### D2: Per-process nonce generated once at module load

**Decision**: `const INSTANCE_NONCE = crypto.randomBytes(8).toString('hex')` at module scope in `event-bus.ts`. Every `EpicEventBus` reads this constant.

**Rationale**: Simplest possible implementation of "per-process instance identifier". No dependency injection, no bus-level state, no test hook needed for the common path. Tests that need to simulate cross-instance behavior override via a test-only constructor parameter (`options.nonce`).

**Alternatives considered**:
- Per-bus random nonce — would misclassify a same-process re-acquire as `discarded`, silently masking bugs; violates FR-005 which ties the nonce to the *process*, not the bus.
- OS-level process ID (`process.pid`) — recycled across process restarts on some platforms; not collision-resistant across container-restart scenarios where a supervisor restarts the process and it inherits the same PID.

### D3: Idle-TTL armed only at refcount-0 transition (Q2-D)

**Decision**: Timer arms in `releaseKey` when refcount drops to 0; timer disarms in `acquireEpicBus` when an existing subscription is found. `emit()` and `waitFor` internals do NOT reset the timer.

**Rationale**: The TTL exists to bound resources for *abandoned* epics; abandonment is defined by caller absence (Q2 answer). A busy-but-abandoned epic (poll produces events, nobody polls the bus) would be a resource leak under Q2-B or Q2-C. Q2-D names the invariant precisely: **a bus is alive iff refcount > 0 or its armed clock is younger than the TTL**.

Invariant is testable: `refCount > 0` XOR `idleTimer != null`.

### D4: Poller pauses at refcount 0; one-shot catch-up on next acquire (Q4-D)

**Decision**: On refcount → 0, `runPollLoop` receives a pause signal (new field on `Subscription`); it retains its `prev: SnapshotMap` and `aggState: AggregateState` but stops the 30 s sleep loop. On next `acquire`, before returning the handle, the registry synchronously runs one `runOnePoll` + `computeAggregateEvents` cycle that diffs against `prev`, emits any new events to the bus, updates `prev`/`aggState`, and *then* returns.

**Rationale**: Q4 answer trades continuous-observer semantics for cost. Between-call events are still delivered — captured by the catch-up diff against the retained snapshot — but the server does not burn GH API budget on epics nobody is currently listening to. The catch-up poll runs on the acquire path (not on the caller's `waitFor` deadline) so the added latency is at most one `resolveEpic + runOnePoll` round-trip.

**Alternatives considered**:
- Full-rate polling (Q4-A/B) — scales badly across many idle-TTL-alive buses, each polling GH.
- Slower cadence (Q4-C) — worst of both worlds: still pays API cost, adds latency.

### D5: LRU soft cap by "last-acquired" wall-clock (Q5-B)

**Decision**: Track `lastActiveAt: number` (wall-clock ms) on each `Subscription`, updated on every `acquire`. Registry keeps a companion `Map` (insertion-order) that also serves as the LRU: on new `acquire` at cap, evict the entry with the oldest `lastActiveAt`. Evicted-bus cursors classify as `discarded` (naturally — the evicted-and-reconstituted bus gets a fresh nonce).

Wait — the nonce is per-*process*, not per-bus. So evict-and-reconstitute would NOT produce a different nonce on its own. Two paths to correctness here:

- (a) Give the *evicted* bus a per-*bus* eviction-generation counter mixed into a bus-local secondary nonce. Cursor payload carries `{ epic, position, nonce, gen }`. Genuine same-process cursors match on both; TTL/LRU-evicted-and-reconstituted match on `nonce` but not `gen` → `discarded`.
- (b) Add the bus-level nonce (random per bus instance) alongside the process-level one. Cursor carries `{ epic, position, pnonce, bnonce }`. Same-process out-of-range with matching `bnonce` → `never-issued`; matching `pnonce` but mismatched `bnonce` → `discarded`; mismatched `pnonce` → `discarded`.

**Chosen**: (b) — cleaner classification (pnonce mismatch and bnonce mismatch both funnel to `discarded`, distinguished from `never-issued` which requires both to match). Legacy no-nonce → `discarded` (Q3-A) still holds. Cost: two 8-hex fields in the JSON payload; base64 tokens grow ~40 bytes.

**Alternatives considered**:
- Hard cap that fails new acquires (Q5-C) — punishes the new epic for old epics' idleness (Q5 answer explicitly rejects).
- No cap (Q5-A) — unbounded × idle-TTL-alive is a leak vector for long-lived servers.

### D6: Legacy cursor detection uses "missing nonce field"

**Decision**: `decodeCursor` returns `{ epic, position, pnonce?, bnonce? }`. `parseCursor` classifies as `discarded` when either `pnonce` or `bnonce` is absent (Q3-A).

**Rationale**: A pre-fix server issued cursors with only `epic` + `position`. On the first post-deploy call the caller silently resets and gets `resetFrom: 'discarded'`. No breaking wire change, no code path treats routine upgrade as caller-bug.

## Testing Strategy

Extend two existing test files, add one new one. All Vitest, all pure in-process (no GH calls) via the existing `noPoll` and `deps.acquired` seams.

- **`event-bus.test.ts`** — nonce round-trip in `encodeCursor`/`decodeCursor`; `parseCursor` returns `discarded` for (a) missing nonce, (b) mismatched pnonce, (c) mismatched bnonce; `never-issued` still returned for same-instance out-of-range.
- **`await-events-cursor-classes.test.ts`** — new case: cursor from a bus with mismatched nonce yields `status: 'ok'` + `resetFrom: 'discarded'`; existing `never-issued` case still yields `invalid-cursor` (same-nonce out-of-range).
- **`event-bus-registry.test.ts`** (new) — full lifecycle assertions:
  - Sequential acquire/release/acquire returns the same bus (refcount 0 keeps bus alive).
  - Idle-TTL fires eviction after configured window; a cursor from the evicted bus classifies as `discarded`.
  - Idle-TTL clock arms at `release` (refcount → 0) and disarms at `acquire` (Q2-D invariant).
  - Poller pause: emit produced by the poller between calls appears in the next `acquire` catch-up (Q4-D).
  - LRU soft cap: 101st acquire evicts the LRU bus; cursor from evicted bus → `discarded`.
  - Legacy cursor (encoded without nonce fields) → `discarded` + `resetFrom`.

All tests use dependency injection for `now()` (fake clock) and `noPoll: true` to run the catch-up path via test-provided `emit`.

## Migration / Compatibility

- **Cursor wire compat**: base64(JSON) unchanged in shape; JSON payload gains `pnonce` and `bnonce` fields (both optional at decode time). Legacy cursors (no fields) classify as `discarded` on first post-deploy call. One-time silent reset per active session.
- **Config compat**: two new env vars; both default to the values the spec chose. No config migration needed.
- **API compat**: `cockpit_await_events` output shape's `resetFrom` becomes `'expired' | 'discarded'` (union widened, existing callers that only inspect `resetFrom === 'expired'` still behave correctly — the field is optional).
- **Agency circuit breaker**: `never-issued` remains a fail-loud class but now truly signals caller bugs, not upgrade artifacts / lifecycle events. Companion agency-side change is out of scope for this repo (spec Out of Scope §3).

## Rollout

Ships in a normal `@generacy-ai/generacy` release. No cluster-image, no cluster-base, no orchestrator companion PR needed. The MCP server is the sole consumer of this code path.

## Suggested next step

`/tasks` to generate the task list from this plan.
