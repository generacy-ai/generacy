# Research: cockpit_await_events lifecycle fix

**Issue**: [#924](https://github.com/generacy-ai/generacy/issues/924)
**Branch**: `924-found-during-cockpit-v1`

## Decisions and rationale

### R1: Where does the bug live?

**Finding**: `event-bus-registry.ts:releaseKey` tears down the subscription at refcount 0:

```ts
function releaseKey(key: string): void {
  const sub = registry.get(key);
  if (sub == null) return;
  sub.refCount -= 1;
  if (sub.refCount <= 0) {
    sub.stop();          // aborts the poller
    registry.delete(key); // drops nextCursor, buffer, snapshot map
  }
}
```

And `tools/cockpit_await_events.ts` releases in a `finally`:

```ts
try {
  return await drainOrWait(acquired.bus, args);
} finally {
  if (releaseAfter) acquired.release();
}
```

For sequential callers (auto-mode, the dominant real pattern) refcount hits 0 between every call, so the second call rebuilds a fresh bus (`nextCursor` restart at 1) and `parseCursor` on any prior cursor classifies as `never-issued` via `event-bus.ts:123`:

```ts
if (decoded.position >= this.nextCursor) return { kind: 'never-issued' };
```

Refcounting is not the wrong primitive — it correctly serves concurrent callers sharing one poller — but the lifecycle it drives is wrong. **The fix is to keep the bus alive across sequential calls with a distinct eviction mechanism (idle-TTL) and to type cursors by lifetime so genuine caller bugs stay distinguishable from routine eviction/restart.**

### R2: Env var naming — why `COCKPIT_MCP_BUS_IDLE_TTL_MS`?

**Existing precedent** (`event-bus.ts:16-17`): `COCKPIT_MCP_EVENT_RETENTION_COUNT`, `COCKPIT_MCP_EVENT_RETENTION_MS`.

**Chosen naming**:
- `COCKPIT_MCP_BUS_IDLE_TTL_MS` (default `600_000`)
- `COCKPIT_MCP_BUS_MAX` (default `100`)

**Rationale**: `COCKPIT_MCP_BUS_*` groups the registry-level knobs; `COCKPIT_MCP_EVENT_RETENTION_*` stays for the per-bus LRU. Reader can tell "this tunes the registry" vs. "this tunes each bus" at a glance. Q1-A approved this pattern explicitly.

### R3: Nonce generation — `crypto.randomBytes(8).toString('hex')` at module scope

**Alternatives evaluated**:
- `process.pid` — recyclable across container restarts, not collision-resistant.
- UUID v4 (`crypto.randomUUID()`) — 36 chars, wire-larger than needed.
- 8-byte hex (16 chars) — 64 bits of entropy, matches typical session-token entropy in the codebase (grep for similar patterns turned up 8-byte hex in `packages/control-plane/src/services/audit.ts` and 4-byte hex in `packages/generacy/src/registry/`).

**Chosen**: 8-byte hex — 16 char string, 64 bits of entropy. Collision probability across a single deploy is negligible; two servers coming online with the same nonce would produce cursor mis-acceptance, but that's a per-request coincidence and detectable by the `bnonce` mismatch check (see R4).

Module-scoped constant so *every* bus in the process shares one `pnonce`. Not injected via `EpicEventBus` constructor except for test overrides.

### R4: Two-nonce cursor payload (process + bus)

**Problem**: With just a process-level nonce, TTL eviction + reconstitution within the same process would keep the same `pnonce`, so an evicted-bus cursor would satisfy the pnonce check and hit `decoded.position >= this.nextCursor` → `never-issued`. That's the *exact* misclassification the spec exists to end.

**Options considered**:
1. Bus-level eviction generation counter (`gen: number`) mixed into the token.
2. Bus-level random nonce (`bnonce`) alongside the process-level one.
3. Skip the second nonce; treat the entire nextCursor reset as a signal to reset all callers (need to remember evicted `pnonce`s in an "evicted set", grows unboundedly).

**Chosen**: Option 2 — bus-level 8-byte hex nonce. Cursor payload: `{ epic, position, pnonce, bnonce }`. Cleanest classification:
- Both nonces match + position in range → `valid`.
- Both nonces match + out-of-range → `never-issued` (**genuine caller bug**).
- `pnonce` matches + `bnonce` mismatches → `discarded` (evicted-and-reconstituted).
- `pnonce` mismatches → `discarded` (server restart).
- Either nonce field missing → `discarded` (legacy cursor, Q3-A).

Cost: two 16-char fields in JSON. Base64-encoded token gains ~50 bytes. Bandwidth cost trivial vs. the cursor already being event-bearing.

### R5: Poller pause vs. background polling (Q4-D)

**Cost math for Q4-A/B (full-rate)**: 1 GH request per 30 s per idle bus × soft cap 100 = ~200 GH requests/min at steady-state saturation of idle buses. Well under the 5000 req/hr authenticated GH limit but noisy and unnecessary.

**Cost math for Q4-D (pause + catch-up)**: 0 requests while paused. On next acquire: 1 `resolveEpic` + 1 `runOnePoll` synchronous. Same total cost as one poll tick, deferred to the moment a caller can consume the result.

**Semantics preservation**: The snapshot map (`SnapshotMap`) held across the pause captures the state at the last successful poll. On resume, `runOnePoll` diffs against this snapshot → produces every net change since the pause. Sub-30-s label churn (label added and removed within one poll interval) is invisible in either mode — that's not a regression, it's the same netting quantization the poll-based watch already has.

### R6: Interaction with `resolveEpic` between calls

`runPollLoop` re-runs `resolveEpic` at the top of every 30 s tick (`event-bus-registry.ts:184-188`). Under Q4-D that becomes: catch-up path also runs `resolveEpic` first, so an epic whose issue-tree changes between calls (parent/child added, tree structure changes) still gets a fresh resolution before the diff.

### R7: LRU tracking

The `Map` insertion-order guarantee (spec'd in ES2020+) means walking `registry.entries()` in insertion order gives the LRU-by-first-insert. To make it LRU-by-last-acquire without extra data structures: on `acquire`, `registry.delete(key); registry.set(key, sub)` to reinsert at tail. On eviction: pick the first entry (`registry.keys().next().value`). O(1) both operations. No secondary index needed.

### R8: Reference sources

- `event-bus.ts`, `event-bus-registry.ts`, `tools/cockpit_await_events.ts` — subject of the fix (read in full for the plan).
- `event-bus.test.ts`, `await-events-cursor-classes.test.ts` — existing test scaffolding to extend.
- `watch/poll-loop.ts`, `watch/aggregate.ts`, `watch/snapshot.ts` — reused by the catch-up path.
- Q1-A / Q2-D / Q3-A / Q4-D / Q5-B in `clarifications.md` — normative for env vars, TTL semantics, legacy cursor, poller cadence, LRU cap.

## Alternatives considered (and rejected)

- **Move `release()` to end-of-session rather than end-of-call**: caller changes only, no server-side fix, forces every MCP caller to hold a session token, changes the tool wire shape. Rejected — the spec wants a server-side fix that keeps the wire shape unchanged.
- **Global bus, no per-epic registry**: single event bus keyed on epic in event payloads. Rejected — breaks the O(1) subscribe-and-diff semantics `runOnePoll` needs a per-epic snapshot for.
- **Persist cursors to disk**: crosses the "in-memory process" assumption (spec Assumptions §1) and adds an I/O path for a non-existent use case (cross-process cursor sharing is out of scope).
