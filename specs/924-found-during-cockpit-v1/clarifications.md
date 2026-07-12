# Clarifications: cockpit_await_events — bus survives between calls; cursors typed by lifetime

**Issue**: [#924](https://github.com/generacy-ai/generacy/issues/924)
**Branch**: `924-found-during-cockpit-v1`

## Batch 1 — 2026-07-12

### Q1: Idle-TTL default and tuning surface

**Context**: FR-002 says "Default TTL: ~10 min (tunable)". `event-bus.ts` already uses env vars (`COCKPIT_MCP_EVENT_RETENTION_COUNT`, `COCKPIT_MCP_EVENT_RETENTION_MS`) for the LRU bounds. Whether the idle-TTL follows the same env-var pattern or is a hardcoded constant affects the operator surface, docs, and test strategy. FR-010 pins the *value* as internal to the MCP contract, but the *config surface* is still an internal-API decision.

**Question**: What is the concrete idle-TTL default and how is it configured?

**Options**:
- A: 600_000 ms (10 min) default with env-var override `COCKPIT_MCP_BUS_IDLE_TTL_MS`, matching the existing retention env-var pattern.
- B: 600_000 ms hardcoded constant, no env override (operators cannot tune without rebuild).
- C: Different default value (specify).
- D: Configured via a different mechanism — config file, CLI flag, etc. (specify).

**Answer**: **A** — 600_000 ms default, env override `COCKPIT_MCP_BUS_IDLE_TTL_MS`. It's the pattern the same module already established for the LRU bounds (`COCKPIT_MCP_EVENT_RETENTION_*`), so it's one idiom, not two; tests get tiny TTLs without rebuild games, and operators get a tuning surface for free. B removes tunability for no gain; D invents a second config mechanism inside a module that already has one.

### Q2: What counts as activity that holds/resets the idle-TTL clock?

**Context**: FR-002 evicts a bus when there is "no waiter and no drain activity for the configured window". The precise definition of "activity" determines when a bus disappears. Candidate signals: (a) a `waitFor` waiter is currently pending, (b) `bus.emit()` fires (poller produced an event), (c) a new `acquire()` call arrives, (d) a `release()` at refcount 0 arms the clock. This affects whether a caller-less-but-event-producing epic survives, and whether a silent-but-drained epic (empty batches every 5 min) survives.

**Question**: Which signal(s) reset the idle-TTL clock (i.e., mark the bus as "alive")?

**Options**:
- A: Any `acquire()` OR any `waitFor` invocation resets. Poll-produced `emit()` alone does NOT — an epic with no callers is evicted even if the poller keeps producing events.
- B: Any `acquire()` OR any `bus.emit()` resets. An always-producing epic never gets evicted, even with no callers.
- C: Union of A and B — any of `acquire`, `waitFor`, `emit` resets the clock.
- D: Only `release()` at refcount 0 arms the clock; any subsequent `acquire()` disarms it (poll-events and empty waitFors don't matter).

**Answer**: **D** — the clock arms at `release()`-to-refcount-0 and disarms on `acquire()`; emits and waiter internals are irrelevant. The TTL exists to bound resources for *abandoned* epics, and abandonment is defined by caller absence, nothing else. Invariant: a bus is alive iff refcount > 0 or its armed clock is younger than the TTL. B and C let a busy-but-abandoned epic (events firing, nobody polling) live forever — a leak with a heartbeat. A converges to D in practice (a `waitFor` only exists inside a call, so refcount is already > 0), but D names the mechanism precisely, which is what the fixture assertions need.

### Q3: Backward compatibility for cursor tokens issued before the instance-nonce change

**Context**: FR-004 requires embedding a per-process instance nonce in the cursor token. The current wire shape is `base64(JSON({epic, position}))`. After the change, three shapes coexist in the wild: (i) new cursor with matching nonce, (ii) new cursor with non-matching nonce (server restart — covered by FR-006), (iii) legacy cursor with no nonce field (issued by a pre-fix server that a caller still holds across upgrade). Case (iii) needs explicit classification since the spec does not name it.

**Question**: How should legacy (no-nonce) cursor tokens be classified when presented after the fix ships?

**Options**:
- A: Treat missing-nonce as `discarded`/reset (with `resetFrom`) — semantically same as cross-instance. Callers experience a one-time silent reset on the first post-deploy call.
- B: Treat missing-nonce as `malformed` — strict schema; caller sees `invalid-cursor` and must fall back to `cursor=undefined`.
- C: Treat missing-nonce as `never-issued` — matches today's misclassification behavior for this case (not recommended, but explicit).
- D: Add a cursor schema version field; legacy = missing version = `discarded` (same effect as A but explicit versioning story).

**Answer**: **A** — missing nonce classifies as `discarded`/reset with `resetFrom`. Semantically the legacy cursor's issuing instance no longer exists — identical to cross-instance, so it takes the same class. Critically *not* B: routing a routine upgrade artifact into the `invalid-cursor` caller-bug class would trip agency#408's circuit breaker (and under strict fail-loud, abort runs) on the first post-deploy call — the exact misclassification this fix exists to end. D's version field buys nothing the nonce doesn't already provide (missing nonce *is* the v1 discriminant) — speculative versioning for short-lived in-memory-era tokens.

### Q4: Poller cadence while the bus is alive but has no active callers

**Context**: FR-003 keeps the poller running between calls so events emitted with no waiter in flight are captured (SC-003). The current poller ticks at `DEFAULT_INTERVAL_MS = 30_000` per bus and does `resolveEpic` + `runOnePoll` (GitHub API traffic) every tick. A long-running auto session that touches many epics can leave many buses in the caller-less-within-TTL state, each polling GitHub at full rate for up to the idle-TTL window. This is a real cost profile (GH API budget, background CPU, socket/DNS pressure).

**Question**: Should the poller cadence change when the bus has refcount=0 but is within the TTL window?

**Options**:
- A: Full rate always (default 30 s) — simple, matches the spec's implied "keeps its poller running" wording. Cost scales with idle-bus count × TTL.
- B: Full rate; accept the cost as the price of FR-003 correctness (explicit "no, we don't optimize this").
- C: Slower cadence (e.g., 2×–5× default) when refcount=0; snap back to full rate on next `acquire()`. Between-call events still delivered but with higher latency.
- D: Pause the poller entirely at refcount=0; recover between-call events via a one-shot catch-up poll at the next `acquire()`. Trades continuous-observer semantics for cost.

**Answer**: **D** — pause the poller at refcount 0; one catch-up poll on the next `acquire()`. Key point: the bus now *retains its snapshot map* across the gap, so the catch-up poll diffs against the last-known state and captures everything that changed while no one was listening — and delivers it exactly when a listener exists to receive it. Observable semantics match continuous polling up to the same netting quantization poll-based watch already has (a label added and removed within one 30s tick is invisible today too; D just widens that window to the inter-call gap, which for the sequential auto session is seconds). Full rate resumes whenever a waiter is in flight. C is the worst of both worlds — background API cost *and* added latency; A/B pay continuous GitHub API traffic per idle bus for events nobody can consume yet.

### Q5: Cap on concurrent live buses

**Context**: With TTL-based eviction (vs. per-call teardown), a server that touches N distinct epics accumulates up to N live buses+pollers during the idle window. LRU bounds memory *per bus*, but there is no bound on the *number* of buses. FR-002 frames the TTL as a "resource-safety upper bound", implying no other cap is intended, but at scale (auto sessions across many epics, batch operations, misbehaving callers) the registry could grow to hundreds of live pollers.

**Question**: Should the registry cap the number of concurrent live buses, and if so, how does it react at the cap?

**Options**:
- A: No cap; TTL alone bounds resources. Operators size their MCP server accordingly.
- B: Soft cap (default e.g. 100) with LRU-style eviction of the least-recently-active bus when a new one is acquired. Evicted-bus cursors classify as `discarded` (same taxonomy as TTL eviction).
- C: Hard cap; new `acquire()` fails when at cap (returns a typed error; caller decides how to react).
- D: Cap by env var (default unlimited), LRU eviction behavior when configured.

**Answer**: **B** — soft cap (default 100), LRU eviction, evicted cursors classify as `discarded`. With Q4-D an idle bus is nearly free, but "nearly free × unbounded" is how long-lived servers leak — bounded-by-default is the right posture, and the eviction is non-silent by construction because the discarded classification reaches the evicted caller through the existing taxonomy (the no-silent-caps principle satisfied structurally). C's hard-fail punishes the *new* epic for old epics' idleness — backwards. Follow the Q1 env pattern for the override (`COCKPIT_MCP_BUS_MAX` or similar).
