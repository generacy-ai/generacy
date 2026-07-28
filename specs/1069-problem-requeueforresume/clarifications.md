# Clarifications

## Batch 1 — 2026-07-28

### Q1: Dead-letter branch fold
**Context**: FR-002 leaves it ambiguous whether `release()`'s dead-letter branch is folded into the same Lua script or kept as a separate `MULTI` after the script returns. SC-004 requires "exactly one Redis round trip on **both** the retry branch and the dead-letter branch", which strongly implies folding, but FR-002 explicitly permits "may remain a subsequent `MULTI`". The two readings are incompatible: a separate `MULTI` guarantees a second round trip on the dead-letter branch and fails SC-004; folding satisfies SC-004 but grows the script.
**Question**: Should the `release()` dead-letter branch be folded into the same Lua script as the retry branch?
**Options**:
- A: Single Lua script that handles both retry AND dead-letter branches internally, dispatching on the (script-computed) `attemptCount + 1 >= maxRetries` condition. One round trip on both branches. `SREM IN_FLIGHT_KEY` fires inside the script on the dead-letter branch only. SC-004 satisfied unambiguously.
- B: One Lua script for retry branch only; when the read shows the item would dead-letter, the script returns "would-dead-letter" without mutating, and the caller runs a subsequent `MULTI` (`hdel + del + zadd DEAD_LETTER + srem IN_FLIGHT`). Two round trips on dead-letter branch. Relaxes SC-004 for that branch.
- C: Two separate Lua scripts (one for retry, one for dead-letter). Caller reads `attemptCount` from an initial `HGET` (or via script return) then dispatches. Three round trips on dead-letter, would regress the race for dead-letter, so likely wrong.

**Answer**: *Pending*

### Q2: attemptCount source and re-pend payload assembly
**Context**: A2 states the script must NOT accept `attemptCount` as a caller-supplied ARGV (that reintroduces the TOCTOU hazard the fix is closing) and offers two alternatives without picking one: (a) the script does `cjson.decode` internally then `cjson.encode` after mutation, or (b) the script returns `attemptCount` and the caller re-invokes. A5 additionally warns that `cjson.encode` does not guarantee stable Lua-table key ordering — which matters because two encodes of the same logical payload could produce distinct member strings, breaking any downstream code that keys on member-string identity (the exact class of bug being fixed elsewhere). This tension needs resolution before implementation.
**Question**: How should the script obtain `attemptCount` from the claim payload and assemble the final re-pend member string?
**Options**:
- A: Script does `cjson.decode(claimed)` internally, mutates `parsed.attemptCount` (+1 for `release`, verbatim for `requeueForResume`), sets `parsed.queueReason`/`priority`/etc from ARGV, then `cjson.encode(parsed)` and `ZADD`. Accepts whatever Lua key ordering emerges. Matches `CLAIM_SCRIPT`'s `claimedAt` pattern (see `redis-queue-adapter.ts:92-94`). Simplest.
- B: Script does `cjson.decode(claimed)` to read `attemptCount` only, then string-substitutes the caller-supplied pre-serialized payload template (which contains a placeholder like `"attemptCount":__PLACEHOLDER__`) via Lua `string.gsub`. Preserves caller-controlled key ordering (A5's stability concern). More brittle.
- C: Script returns `parsed.attemptCount` to the caller. Caller re-invokes a second script (or `MULTI`) with the built payload. Two round trips — defeats FR-001 for the happy path. Almost certainly wrong.

**Answer**: *Pending*

### Q3: Return code contract
**Context**: FR-005 requires "unambiguous outcome codes" for caller-side logging (`no-op (already-cleared)` vs `re-pended` vs, for `release`, `dead-lettered`) but does not specify the exact integer codes or whether payload data is returned alongside. `RECLAIM_ORPHAN_SCRIPT` returns 0/1/2/3 integer codes. The choice affects the caller's switch shape and what fields are available for the `logger.info` line (specifically whether `attemptCount` needs to appear in the log).
**Question**: What return-code contract should the two scripts adopt?
**Options**:
- A: Integer-only. `requeueForResume` → 0 (no-op) or 1 (re-pended). `release` → 0 (no-op), 1 (retry re-pended), or 2 (dead-lettered). Caller cannot log the mutated `attemptCount` without an extra round trip (accept the loss — current log line's `attemptCount` becomes best-effort, or drop it entirely from the null-guard path).
- B: Tuple return. `requeueForResume` returns `{code, attemptCount}`. `release` returns `{code, attemptCount}`. Caller logs the actual mutated count on every branch. Small bytes overhead per call.
- C: Return the fully-mutated payload as a JSON string on success, empty string on no-op. Caller can log anything from the payload but pays the encoding round-trip cost across the wire.

**Answer**: *Pending*

### Q4: Concurrency regression test methodology
**Context**: SC-001 targets "100% pass (0 failing runs across ≥100)" for a concurrent `reapOrphanClaims` + `requeueForResume` test asserting `ZCARD pending == 1`. The phrasing "≥100" is genuinely ambiguous — it could mean (a) 100 concurrent iterations in one test invocation, (b) 100 sequential single-iteration test invocations in CI, or (c) both. The three shapes have different CI cost and different diagnostic value. The choice also drives whether SC-003/SC-004's "MONITOR-based test or command-count assertion" is a separate test or piggybacks on the concurrency test.
**Question**: How should the concurrency + round-trip regression tests be structured?
**Options**:
- A: Single test iterates N=100 pairs sequentially against a real Redis, each pair firing `reap` and `requeue`/`release` concurrently via `Promise.all`, and asserts `ZCARD == 1` after each pair. Round-trip count checked via a wrapped `ioredis` command counter in the same test. One test file, ~10s CI runtime.
- B: Two tests. Concurrency test fires N=1000 pairs in a single `Promise.all` batch (heavy stress). Separate MONITOR-based test does the single-call round-trip assertion. Higher CI cost, better catches thundering-herd bugs.
- C: Concurrency test uses a controlled interleave — a Redis proxy or command-hook injects the reap script between the read and re-pend deterministically (works against pre-fix code to prove the test itself is diagnostic; against the fix, uses natural `Promise.all` since the fix removes the interleave window entirely). Best diagnostic quality; most complex.

**Answer**: *Pending*
