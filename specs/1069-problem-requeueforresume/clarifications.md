# Clarifications

## Batch 1 — 2026-07-28

### Q1: Dead-letter branch fold
**Context**: FR-002 leaves it ambiguous whether `release()`'s dead-letter branch is folded into the same Lua script or kept as a separate `MULTI` after the script returns. SC-004 requires "exactly one Redis round trip on **both** the retry branch and the dead-letter branch", which strongly implies folding, but FR-002 explicitly permits "may remain a subsequent `MULTI`". The two readings are incompatible: a separate `MULTI` guarantees a second round trip on the dead-letter branch and fails SC-004; folding satisfies SC-004 but grows the script.
**Question**: Should the `release()` dead-letter branch be folded into the same Lua script as the retry branch?
**Options**:
- A: Single Lua script that handles both retry AND dead-letter branches internally, dispatching on the (script-computed) `attemptCount + 1 >= maxRetries` condition. One round trip on both branches. `SREM IN_FLIGHT_KEY` fires inside the script on the dead-letter branch only. SC-004 satisfied unambiguously.
- B: One Lua script for retry branch only; when the read shows the item would dead-letter, the script returns "would-dead-letter" without mutating, and the caller runs a subsequent `MULTI` (`hdel + del + zadd DEAD_LETTER + srem IN_FLIGHT`). Two round trips on dead-letter branch. Relaxes SC-004 for that branch.
- C: Two separate Lua scripts (one for retry, one for dead-letter). Caller reads `attemptCount` from an initial `HGET` (or via script return) then dispatches. Three round trips on dead-letter, would regress the race for dead-letter, so likely wrong.

**Answer**: **A** — fold the dead-letter branch into the same Lua script.

B is not merely "relaxes SC-004 for that branch" — it is unsafe, and it reintroduces this issue's bug on the path it exempts. Walk the interleave: script reads the claim, computes that the item would dead-letter, returns without mutating. Caller then runs `hdel + del + zadd DEAD_LETTER + srem IN_FLIGHT` in a second round trip. Between those two round trips, `reapOrphanClaims` can interleave — it `HDEL`s the claim and `ZADD`s a re-pend to `PENDING_KEY`, deliberately leaving the in-flight member intact. The caller's subsequent `MULTI` then fires and `SREM`s the in-flight member. Result: a pending member with no in-flight member — the broken `in-flight = pending ∪ claimed` invariant that #1060 just finished restoring, and the state that lets a later `enqueueIfAbsent` pass its `SISMEMBER` guard and add a duplicate. B moves the TOCTOU from the retry branch to the dead-letter branch and adds an invariant violation on top.

C is worse still (three round trips, and regresses the race for dead-letter by its own admission).

A is the only option that actually closes the window. The script grows by a conditional, which is a small price for a branch that mutates four keys.

### Q2: attemptCount source and re-pend payload assembly
**Context**: A2 states the script must NOT accept `attemptCount` as a caller-supplied ARGV (that reintroduces the TOCTOU hazard the fix is closing) and offers two alternatives without picking one: (a) the script does `cjson.decode` internally then `cjson.encode` after mutation, or (b) the script returns `attemptCount` and the caller re-invokes. A5 additionally warns that `cjson.encode` does not guarantee stable Lua-table key ordering — which matters because two encodes of the same logical payload could produce distinct member strings, breaking any downstream code that keys on member-string identity (the exact class of bug being fixed elsewhere). This tension needs resolution before implementation.
**Question**: How should the script obtain `attemptCount` from the claim payload and assemble the final re-pend member string?
**Options**:
- A: Script does `cjson.decode(claimed)` internally, mutates `parsed.attemptCount` (+1 for `release`, verbatim for `requeueForResume`), sets `parsed.queueReason`/`priority`/etc from ARGV, then `cjson.encode(parsed)` and `ZADD`. Accepts whatever Lua key ordering emerges. Matches `CLAIM_SCRIPT`'s `claimedAt` pattern (see `redis-queue-adapter.ts:92-94`). Simplest.
- B: Script does `cjson.decode(claimed)` to read `attemptCount` only, then string-substitutes the caller-supplied pre-serialized payload template (which contains a placeholder like `"attemptCount":__PLACEHOLDER__`) via Lua `string.gsub`. Preserves caller-controlled key ordering (A5's stability concern). More brittle.
- C: Script returns `parsed.attemptCount` to the caller. Caller re-invokes a second script (or `MULTI`) with the built payload. Two round trips — defeats FR-001 for the happy path. Almost certainly wrong.

**Answer**: **A** — script does `cjson.decode` → mutate → `cjson.encode`.

A5's key-ordering concern is only real if something keys on the exact member string. Nothing does. There is no `zrem`, no `zscore`, and no member-identity lookup anywhere in `redis-queue-adapter.ts`. Pending members are consumed by `ZPOPMIN` inside `CLAIM_SCRIPT` and otherwise read wholesale via `ZRANGE` (`:353`, `:936`) and parsed. Two encodes of the same logical payload producing different byte strings cannot create a duplicate member or orphan a lookup. The duplicate-member hazard in #1060 came from payloads that differed *semantically* (`queueReason` / `priority` / `attemptCount` / `enqueuedAt`), not from encoder instability.

And the ordering B tries to preserve is already gone. `CLAIM_SCRIPT` (`redis-queue-adapter.ts:87-95`) does precisely the A pattern today:

```lua
local parsed = cjson.decode(member)
parsed.claimedAt = ARGV[2]
local reserialized = cjson.encode(parsed)
redis.call('HSET', KEYS[2], itemKey, reserialized)
```

So the claimed-hash payload that `release()` and `requeueForResume()` read has already been through a Lua `cjson` round trip. Whatever key ordering the caller originally produced was discarded at claim time. B would be protecting a property that no longer exists by the time these scripts run.

B is also a `string.gsub` over JSON, a footgun in its own right: silently misfires if any string value in the payload contains the placeholder token, and couples the script to the caller's exact serialization. A matches in-file precedent, and precedent here is not just convention — it is the reason the concern is moot.

### Q3: Return code contract
**Context**: FR-005 requires "unambiguous outcome codes" for caller-side logging (`no-op (already-cleared)` vs `re-pended` vs, for `release`, `dead-lettered`) but does not specify the exact integer codes or whether payload data is returned alongside. `RECLAIM_ORPHAN_SCRIPT` returns 0/1/2/3 integer codes. The choice affects the caller's switch shape and what fields are available for the `logger.info` line (specifically whether `attemptCount` needs to appear in the log).
**Question**: What return-code contract should the two scripts adopt?
**Options**:
- A: Integer-only. `requeueForResume` → 0 (no-op) or 1 (re-pended). `release` → 0 (no-op), 1 (retry re-pended), or 2 (dead-lettered). Caller cannot log the mutated `attemptCount` without an extra round trip (accept the loss — current log line's `attemptCount` becomes best-effort, or drop it entirely from the null-guard path).
- B: Tuple return. `requeueForResume` returns `{code, attemptCount}`. `release` returns `{code, attemptCount}`. Caller logs the actual mutated count on every branch. Small bytes overhead per call.
- C: Return the fully-mutated payload as a JSON string on success, empty string on no-op. Caller can log anything from the payload but pays the encoding round-trip cost across the wire.

**Answer**: **B** — tuple `{ code, attemptCount }`.

The existing log line reports `attemptCount`, and that number is the operator's only warning that an item is approaching `maxRetries`. "attempt 2 of 3" is actionable; "released" is not. A drops it on exactly the branch where it carries the most information.

That trade is especially hard to justify right now, because #1070 — in flight alongside this one — exists entirely because a disposition was under-reported and an operator was sent after the wrong cause. Spending a few bytes per call to keep a diagnostic field honest is the cheapest thing in this issue.

C returns the whole payload, which pays encoding and wire cost for fields no caller needs.

### Q4: Concurrency regression test methodology
**Context**: SC-001 targets "100% pass (0 failing runs across ≥100)" for a concurrent `reapOrphanClaims` + `requeueForResume` test asserting `ZCARD pending == 1`. The phrasing "≥100" is genuinely ambiguous — it could mean (a) 100 concurrent iterations in one test invocation, (b) 100 sequential single-iteration test invocations in CI, or (c) both. The three shapes have different CI cost and different diagnostic value. The choice also drives whether SC-003/SC-004's "MONITOR-based test or command-count assertion" is a separate test or piggybacks on the concurrency test.
**Question**: How should the concurrency + round-trip regression tests be structured?
**Options**:
- A: Single test iterates N=100 pairs sequentially against a real Redis, each pair firing `reap` and `requeue`/`release` concurrently via `Promise.all`, and asserts `ZCARD == 1` after each pair. Round-trip count checked via a wrapped `ioredis` command counter in the same test. One test file, ~10s CI runtime.
- B: Two tests. Concurrency test fires N=1000 pairs in a single `Promise.all` batch (heavy stress). Separate MONITOR-based test does the single-call round-trip assertion. Higher CI cost, better catches thundering-herd bugs.
- C: Concurrency test uses a controlled interleave — a Redis proxy or command-hook injects the reap script between the read and re-pend deterministically (works against pre-fix code to prove the test itself is diagnostic; against the fix, uses natural `Promise.all` since the fix removes the interleave window entirely). Best diagnostic quality; most complex.

**Answer**: **C** — deterministic controlled interleave, plus two pragmatic additions.

A and B both rely on natural racing to land inside a window this issue itself describes as the few milliseconds between two Redis round trips. A test like that will pass 100/100 — or 1000/1000 — against the *unfixed* code, because the odds of the scheduler placing the reap precisely in that gap are tiny. It would then be merged as proof of a fix it never exercised.

This is the same defect raised on #1065: **a regression test that cannot fail for the bug it pins is not a test.** C is the only option that can be demonstrated diagnostic — inject the reap between the read and the mutate deterministically, show the assertion FAILS against pre-fix code, then show it passes against the fix. That demonstration is the deliverable, not the passing run.

Two pragmatic additions, since C's cost is the stated objection:
- Keep a cheap **natural-race smoke test** (N=100, `Promise.all` per pair) as complement. It is nearly free and guards against unrelated regressions. Do not treat it as the proof.
- Make the **round-trip-count assertion a separate, plain test** with a wrapped `ioredis` command counter. Has nothing to do with concurrency and does not need the interleave harness — folding it in makes both harder to read.

Note: once the fix lands, the interleave window is closed structurally (there is no longer a point between read and mutate to inject into), so C's harness naturally degenerates to the `Promise.all` form against the fixed code. That is the expected outcome, not a gap.
