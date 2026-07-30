# Research: Atomic `requeueForResume()` / `release()` re-pend

## Decision 1 — Two new Lua scripts via `defineCommand` (`REQUEUE_FOR_RESUME_SCRIPT`, `RELEASE_SCRIPT`)

**Chosen**: Add two new script constants next to the three existing ones (`ENQUEUE_IF_ABSENT_SCRIPT`, `CLAIM_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`). Register with `redis.defineCommand('requeueForResume', { numberOfKeys: 3, lua: REQUEUE_FOR_RESUME_SCRIPT })` and `redis.defineCommand('release', { numberOfKeys: 5, lua: RELEASE_SCRIPT })` behind `ensureRequeueForResumeCommand()` / `ensureReleaseCommand()` guards, following the sibling `ensureEnqueueIfAbsentCommand()` at `redis-queue-adapter.ts:234-241` and `ensureReclaimOrphanCommand()` at `:243-250`.

**Rationale**: FR-001 and FR-002 demand co-atomic read-and-mutate. The two-round-trip `HGET` → `MULTI(HDEL + DEL + ZADD)` shape has a **few-millisecond TOCTOU window** between the two round trips (spec §Severity). `RECLAIM_ORPHAN_SCRIPT` (already merged as part of #1054/PR #1056) is the direct precedent for exactly this pattern: it does `HGET` → `HDEL` → `ZADD` inside one Lua script, running atomically on the Redis server. Anything less than a single Lua invocation cannot close the window (see Alternatives).

**Alternatives considered**:

- **Optimistic `WATCH`/`MULTI`/`EXEC` on the claim key** — rejected. Retry-on-`WATCH`-failure adds a client-side loop, doubles the RTT budget on collision, and diverges from the "one Lua script per atomic sequence" convention every other adapter method already follows. `RECLAIM_ORPHAN_SCRIPT` itself demonstrates that the codebase's answer to this pattern is Lua, not WATCH.
- **Client-side lock (`SETNX orchestrator:queue:release-lock:<workerId>:<itemKey>`)** — rejected. Adds a fourth key namespace, requires TTL tuning against `RECLAIM_ORPHAN_SCRIPT`'s grace window, and turns the failure mode from "duplicate pending member" (recoverable via reap) into "stuck lock" (requires manual DEL). Strictly worse.
- **Two separate scripts for `release()` (retry-only + dead-letter-only)** — Clarifications Q1 option C. Rejected: three round trips on dead-letter branch, regresses the race for that branch by its own admission, and imposes a caller-side `HGET` to read `attemptCount` before dispatching — which is precisely the TOCTOU hazard being closed.
- **Return "would-dead-letter" from a retry-only script and let the caller run a subsequent `MULTI` for dead-letter (Q1 option B)** — rejected. The clarifications answer to Q1 spells out why this is unsafe: between the script's "would-dead-letter" return and the caller's subsequent `MULTI`, `reapOrphanClaims` can interleave (`HDEL claim` + `ZADD pending`, deliberately leaving in-flight intact), then the caller's `MULTI` fires and `SREM`s in-flight. Result: a pending member with no in-flight member — the exact `in-flight = pending ∪ claimed` invariant violation that #1060 just restored. B moves the TOCTOU from retry branch to dead-letter branch and adds an invariant violation on top.

**Sources**: `redis-queue-adapter.ts:51-59` (`ENQUEUE_IF_ABSENT_SCRIPT` shape), `redis-queue-adapter.ts:132-154` (`RECLAIM_ORPHAN_SCRIPT` — the direct precedent), `redis-queue-adapter.ts:234-250` (`ensureXCommand()` guard pattern), spec §Q1 answer for the invariant-violation walkthrough.

## Decision 2 — Fold `release()` dead-letter branch into the same script as retry (Q1 → A)

**Chosen**: `RELEASE_SCRIPT` is a single Lua script that handles both retry AND dead-letter branches internally, dispatching on the script-computed `attemptCount + 1 >= maxRetries` condition. One round trip on both branches (satisfies SC-004 unambiguously). `SREM IN_FLIGHT_KEY` fires inside the script on the dead-letter branch only; the retry branch preserves in-flight membership (FR-006).

**Rationale**: See Decision 1's rejection of Q1 option B. The script grows by a conditional (5 extra lines) and gains two extra keys (`DEAD_LETTER_KEY`, `IN_FLIGHT_KEY`) plus one extra ARGV (`maxRetries`); the atomicity + invariant-preservation benefit is worth that price. `numberOfKeys` for `RELEASE_SCRIPT` becomes `5` (KEYS[1] pending, KEYS[2] claimed:<workerId>, KEYS[3] heartbeat, KEYS[4] dead-letter, KEYS[5] in-flight-items). Under Redis Cluster all five must hash to the same slot; A8 asserts this via `RECLAIM_ORPHAN_SCRIPT` precedent (which already declares `pending` + `claimed:<workerId>` + `heartbeat` in the same script — the additional `dead-letter` and `in-flight-items` are the same shape).

**Alternatives**: Q1 options B (separate `MULTI`) and C (two scripts) — both rejected in clarifications for reintroducing TOCTOU and (for B) for adding an invariant violation.

**Sources**: Spec §Q1 answer, `redis-queue-adapter.ts:763-806` (current `release()` dead-letter + retry branch shapes).

## Decision 3 — `attemptCount` read inside Lua via `cjson.decode` → mutate → `cjson.encode` (Q2 → A)

**Chosen**: Both scripts `cjson.decode(claimed)` internally to read `attemptCount`, mutate `parsed.attemptCount` (verbatim for `requeueForResume`, `+1` for `release`), set `parsed.queueReason` / `parsed.priority` / `parsed.enqueuedAt` from ARGV (or preserve — see per-script contract), then `cjson.encode(parsed)` and `ZADD`. `parsed.claimedAt` is set to `nil` before re-encoding to strip the claim-lifecycle field (A6).

**Rationale**: Q2 answer's reasoning applies verbatim. The key-ordering concern in A5 was superseded by audit: nothing in `redis-queue-adapter.ts` performs a member-string identity lookup on pending members (`ZPOPMIN` inside `CLAIM_SCRIPT` consumes by member string but does not compare across encodes; `ZRANGE` at `:353` and `:936` reads wholesale and parses each). `CLAIM_SCRIPT` at `:87-95` already does the exact same `cjson.decode` → mutate → `cjson.encode` pattern for `claimedAt` injection, so the caller-side key ordering B tries to preserve is already lost by the time these scripts run.

**Alternatives**:

- **Q2 option B (string.gsub over a placeholder-templated payload)** — rejected. Silent misfire if any string value in the payload contains the placeholder token; couples the script to the caller's exact serialization; solves a non-problem (no member-identity lookup exists to break).
- **Q2 option C (script returns `attemptCount` to the caller, caller re-invokes with a built payload)** — rejected. Two round trips per call; defeats FR-001 for the happy path.

**Sources**: `redis-queue-adapter.ts:87-95` (`CLAIM_SCRIPT`'s `claimedAt` injection precedent), Spec §Q2 answer, `grep -n 'zrem\|zscore' packages/orchestrator/src/services/redis-queue-adapter.ts` → 0 matches (verified 2026-07-28).

## Decision 4 — Return tuple `{ code, attemptCount }` (Q3 → B)

**Chosen**: Both scripts return a Lua array `{ code, attemptCount }`. `requeueForResume`: `code ∈ {0, 1}` (0 = no-op / already-cleared, 1 = re-pended). `release`: `code ∈ {0, 1, 2}` (0 = no-op, 1 = retry re-pended, 2 = dead-lettered). `attemptCount` on branches 1/2 is the post-mutation value; on branch 0 it is `-1` (sentinel).

**Rationale**: The existing log lines at `redis-queue-adapter.ts:802-805` (`release` retry) and `:879-887` (`requeueForResume` success) both report `attemptCount`. That number is the operator's only warning that an item is approaching `maxRetries`. Q3 option A (integer-only) drops that field on exactly the branches where it carries the most information. Q3 option C (return the whole encoded payload) pays encoding + wire cost for fields no caller reads. B is the middle path: two extra bytes per call, preserves every diagnostic operators depend on.

**Alternatives**: Q3 A (integer only), Q3 C (full payload as JSON string) — both rejected in clarifications for the reasons above. A additionally weakens ops observability at exactly the moment the disposition-reporting concerns raised in #1070 argue for keeping diagnostic fidelity high.

**Sources**: Spec §Q3 answer, `redis-queue-adapter.ts:801-805` (current retry log line), `:879-887` (current requeueForResume log line), `:782-785` (current dead-letter log line).

## Decision 5 — Deterministic controlled-interleave concurrency test (Q4 → C)

**Chosen**: The load-bearing regression test uses a **deterministic controlled interleave**. A Redis proxy or `ioredis` command-hook injects a full `reapOrphanClaims` call between the read and mutate phases of the target method's *pre-fix* code, demonstrating the assertion FAILS (proving diagnostic value). Against the fixed code, the harness naturally degenerates to `Promise.all` because the fix structurally closes the interleave window — the demonstration is that the assertion PASSES against the fix (as opposed to passing against the unfixed code, which is what a natural-race test would do).

**Rationale**: Q4 answer. The core problem is that a natural-race `Promise.all` test — even at N=1000 — would pass against the unfixed code. The odds of the scheduler placing `reapOrphanClaims`'s three-command execution precisely between `HGET` return and `MULTI` execution in the caller's 5–10ms round-trip budget are tiny. The test would be merged as proof of a fix it never exercised. This is the same defect raised on #1065. **A regression test that cannot fail for the bug it pins is not a test.** C is the only shape that can be demonstrated diagnostic.

**Two pragmatic additions** (from Q4 answer):

- **Cheap natural-race smoke test** (N=100, `Promise.all` per pair) — retained as complement. It is nearly free and guards against unrelated regressions. Not the proof.
- **Round-trip-count assertion as a separate, plain test** with a wrapped `ioredis` command counter. No concurrency harness. Folding it into the concurrency test makes both harder to read.

**Implementation note**: the "demonstrate failure on pre-fix" step is critical. Options for staging that demonstration:

- **Option 1 (recommended)**: `git stash`-guarded companion script in `quickstart.md` that runs the deterministic test against pre-fix code once during PR review; failure output is copy-pasted into the PR description as evidence. Doesn't require versioning a snapshot file.
- **Option 2**: Snapshot the pre-fix failure via `test.skip` + `.baseline` comment; brittle across pre-fix code drift.
- **Option 3**: Feature-flag the fix behind an env var and run the same test both ways in CI; adds an env-var proliferation risk for one PR.

Recommend Option 1 — the demonstration is a reviewer-facing artifact, not a CI-enforced gate.

**Sources**: Spec §Q4 answer, `redis-queue-adapter.ts:132-154` (`RECLAIM_ORPHAN_SCRIPT` execution model — the injection target).

## Decision 6 — Real ioredis against a live `redis:7` service for the concurrency tests (FR-010)

**Chosen**: The new `redis-queue-adapter.{release,requeueForResume}-atomic.test.ts` files use real `ioredis` against a live `redis:7` service, following the pattern established by the pre-existing `redis-queue-adapter.orphan-reclaim.test.ts` (stateful mock; catches shape but not command-sequence bugs) plus the `redis-queue-adapter.reclaim-lua.test.ts` (ioredis-mock; runs Lua via `fengari` but lacks `cjson`).

**Rationale**: FR-010 explicitly forbids stubbing or reimplementing Lua in TypeScript for these tests — the whole point is that a mocked SET/HASH would not catch a mis-issued `SADD`/`SREM` command shape. Additionally:

- `ioredis-mock`'s `fengari` VM does NOT expose `cjson` (documented at `redis-queue-adapter.reclaim-lua.test.ts:22-27`). Both new scripts use `cjson.decode`/`encode` on the claim payload (Decision 3). This structurally rules out `ioredis-mock` for the new scripts — they will crash on `cjson.decode is nil`.
- The stateful mock in `redis-queue-adapter.orphan-reclaim.test.ts` correctly re-implements script semantics in JS for shape testing but structurally cannot catch a command-sequence bug (the exact class of bug being fixed).

The only remaining option is real ioredis against a live Redis. The CI harness already provides a `redis:7` service for the existing `redis-queue-adapter.reclaim-lua.test.ts`. No new CI infrastructure required.

**Sources**: `redis-queue-adapter.reclaim-lua.test.ts:22-27` (documented fengari `cjson` limitation), `redis-queue-adapter.orphan-reclaim.test.ts:5-21` (documented mock-shape limitation), FR-010 verbatim.

## Decision 7 — `InMemoryQueueAdapter` requires no source change (FR-009)

**Chosen**: `in-memory-queue-adapter.ts` is unchanged. Optional single-line comment above `release()` and `requeueForResume()` marking the FR-009 parity audit. Log-line messages and field shapes at `:236-240`, `:263-266`, `:278-281`, `:296-300`, `:319-327` all already match the Redis adapter's `:753-756`, `:782-785`, `:802-805`, `:853-856`, `:879-887` respectively — parity was written in from the start.

**Rationale**: FR-009 and OoS-5 both scope in-memory as no-behaviour-change. The adapter is single-threaded within a single Node.js process, so the TOCTOU race cannot occur there. All the fix contributes on the in-memory side is *test parity*: the same `{ code, attemptCount }` return shape (adapted to TS values) so `queue-adapter-parity.test.ts` continues to pass. Because the current in-memory implementation already computes the same `attemptCount` and takes the same branches, the parity holds by construction. No test parity file needs to change unless a reviewer specifically requests a `{ code, attemptCount }` tuple return from the in-memory adapter's *private helpers* (which would be new interface; not in scope).

**Alternatives**: A minimal in-memory refactor to fold the `if (!claimed)` check into a private `_atomicRelease()` helper — rejected. Adds file diff for no observable benefit. The single-threaded execution model already delivers the invariant.

**Sources**: `in-memory-queue-adapter.ts:225-283` (`release()`), `:290-328` (`requeueForResume()`), spec FR-009 + OoS-5.

## Decision 8 — Preserve every existing log field and message text verbatim (FR-005, SC-007)

**Chosen**: The rewrite in Phase 2 (steps 5–7 in plan.md) keeps every log field and every message string byte-for-byte identical to the current implementation. Only the *source* of `attemptCount` changes (tuple element 1 instead of local variable). No new fields; no removed fields; no message-text drift.

**Rationale**: SC-007 (zero new failing tests) + the strong operator-observability argument from Q3 answer both force this. Log-line shape is an operator interface — grep patterns, log-query saved views, and any alert rules key on the exact text. Changing the message strings — even for the better — is not in scope. `redis-queue-adapter.ts:753-756` (`'release() called on already-cleared claim (reaper race) — skipping re-pend to avoid duplicate pending member'`), `:782-785` (`'Item dead-lettered after max retries'`), `:802-805` (`'Item released back to pending queue'`), `:853-856` (`'requeueForResume() called on already-cleared claim (reaper race) — skipping re-pend'`), `:879-887` (`'Item re-pended at resume priority (attemptCount preserved)'`) all preserved verbatim.

**Sources**: Spec SC-007, Spec §Q3 answer.

## Decision 9 — Changeset severity: `patch`

**Chosen**: `patch` bump on `@generacy-ai/orchestrator`.

**Rationale**: SC-008 explicitly asserts zero public API signature change on `QueueManager` (`release`, `requeueForResume` both retain `Promise<void>` — FR-008). This is a pure internal correctness fix. `pnpm why @generacy-ai/orchestrator` verification at implement time should confirm no external monorepo sibling depends on the two methods' timing or log-line-count behaviour; if such a dependency is found, upgrade to `minor` (unexpected).

**File**: `.changeset/1069-atomic-release-requeue-resume.md` — single file per the CLAUDE.md gate. Bump line: `'@generacy-ai/orchestrator': patch`.

**Sources**: SC-008, FR-008, CLAUDE.md changeset rules.

## Implementation patterns to reuse

- **Lua script constant + `ensureXCommand()` guard**: `redis-queue-adapter.ts:34-59` for `ENQUEUE_IF_ABSENT_SCRIPT`, `:86-99` for `CLAIM_SCRIPT`, `:132-154` for `RECLAIM_ORPHAN_SCRIPT`, and their matching `ensureX()` guards at `:225-250`.
- **`cjson.decode` → mutate → `cjson.encode` on a claim payload**: `CLAIM_SCRIPT` at `redis-queue-adapter.ts:87-95`. Same pattern applied to both new scripts.
- **Return-code enum via Lua `return N`**: `RECLAIM_ORPHAN_SCRIPT` at `redis-queue-adapter.ts:100-106` (returns 0/1/2/3 integers). New scripts extend by returning a two-element array `{ code, attemptCount }` — the tuple shape is new to this codebase but is standard Redis-Lua and idiomatic ioredis.
- **`@internal` script export for static-assertion tests**: `_ENQUEUE_IF_ABSENT_SCRIPT_FOR_TESTS` at `redis-queue-adapter.ts:67`. Same shape for `_RELEASE_SCRIPT_FOR_TESTS` and `_REQUEUE_FOR_RESUME_SCRIPT_FOR_TESTS`.
- **Real-ioredis test file structure**: `redis-queue-adapter.reclaim-lua.test.ts` — established pattern for a live-Redis (or `ioredis-mock`) test with `beforeEach` `flushall` + fresh adapter construction.
- **Static script-wiring assertions**: `redis-queue-adapter.script-wiring.test.ts` at `:33-75` for the text-order assertions and `:77-158` for the `defineCommand` mock-based wire-up assertions.

## Non-goals reaffirmed (from spec §Out of Scope)

- OoS-1: no changes to `enqueue()`, `enqueueIfAbsent()`, or `CLAIM_SCRIPT` (owned by #1060/PR #1065).
- OoS-2: no changes to reaper grace-window or heartbeat-expiry semantics.
- OoS-3: no `QueueManager` interface changes — both methods stay `Promise<void>` (FR-008 / SC-008).
- OoS-4: no `WorkerDispatcher`, `label-monitor-service`, `pr-feedback-monitor-service` changes.
- OoS-5: no `InMemoryQueueAdapter` behavioural change beyond parity audit.
- OoS-6: no new Redis keys, no new persisted state, no new heartbeat semantics.
- OoS-7: no new observability / telemetry beyond existing `logger.info` / `logger.warn` lines.
- OoS-8: no companion changes to any other repo.
