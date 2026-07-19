# Feature Specification: ## Summary

Both smee SSE consumers — the orchestrator's `SmeeWebhookReceiver` and the cockpit doorbell's `SmeeDoorbellSource` — use an exponential reconnect backoff **capped at 5 minutes**

**Branch**: `991-summary-both-smee-sse` | **Date**: 2026-07-18 | **Status**: Draft

## Summary

## Summary

Both smee SSE consumers — the orchestrator's `SmeeWebhookReceiver` and the cockpit doorbell's `SmeeDoorbellSource` — use an exponential reconnect backoff **capped at 5 minutes**. After a transient smee.io outage (or any connection blip), the backoff climbs to that cap, so even once smee.io is healthy again a client can sit **disconnected for up to 5 more minutes** before its next reconnect attempt. During that window there is no real-time delivery: the orchestrator falls back to its safety-net poll and the operator `/cockpit:auto` doorbell goes silent, forcing the auto loop onto its 300s heartbeat. A brief upstream blip becomes a multi-minute real-time outage.

## Evidence (snappoll preview cluster, 2026-07-18)

smee.io returned `500 Internal Server Error` / `fetch failed` for ~15 min; the orchestrator's reconnect ladder backed off to the cap and stayed there:

```
Smee connection failed: 500 Internal Server Error   attempt 5   reconnectMs 160000
Smee connection failed: 500 Internal Server Error   attempt 6   reconnectMs 300000
Smee connection failed: 500 Internal Server Error   attempt 7   reconnectMs 300000
Connected to smee.io channel                         ← finally recovered
```

Session-wide the orchestrator processed **38 webhook events vs 1671 poll** — smee delivery was effectively down for most of the run, and recovery was gated by the 5-min backoff. The operator doorbell (same channel) couldn't deliver `phase-complete` wakes, so the `/cockpit:auto` session idled on its 300s heartbeat between phases (the observed "it has work to do but goes to sleep waiting for a wake" behaviour). Once smee reconnected, real-time resumed and the next phase queued normally.

## Root cause

Identical exponential-backoff-capped-at-5-min in two near-verbatim copies (the doorbell source explicitly models its ladder on the receiver):

- `packages/orchestrator/src/services/smee-receiver.ts:69` — `private static readonly MAX_BACKOFF_MS = 300000; // 5 minutes`; `:495-497` — `delay = baseReconnectDelayMs * Math.pow(2, attempt)` then `Math.min(delay, MAX_BACKOFF_MS)`; base default ~5000ms. Ladder: 5s → 10s → 20s → 40s → 80s → 160s → **300s (cap)**.
- `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts:29-30` — `DEFAULT_BASE_RECONNECT_DELAY_MS = 5_000`, `MAX_BACKOFF_MS = 300_000`; `:219-222` — same formula.

The cap is fine as an anti-hammer guard during a genuinely long outage, but 5 minutes is far too long for a real-time transport whose whole purpose is low-latency delivery — most smee blips are seconds-to-a-minute, and the cap turns them into up-to-5-min stalls. `reconnectAttempt` already resets to 0 on a successful connect, so the only problem is the ceiling (and the lack of jitter).

## Proposed fix

1. Lower `MAX_BACKOFF_MS` to **`30_000` (30s)** in both files (ladder becomes 5s → 10s → 20s → 30s(cap)), so a client reconnects within ~30s of smee.io recovering.
2. Add **equal jitter** — `delay = capped/2 + random(0, capped/2)` where `capped = min(base * 2^attempt, MAX_BACKOFF_MS)` — applied at every attempt including `attempt=0`, so a fleet of clients (orchestrator + N doorbells on the same channel) don't reconnect in lockstep against a just-recovered endpoint.
3. Keep the 5s base; the change is only the cap + jitter.
4. Factor the shared `calculateBackoffDelay` into a single leaf package (e.g. `packages/smee-backoff`, subject to plan-phase confirmation) imported by both `packages/orchestrator/src/services/smee-receiver.ts` and `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts`. This is the SSOT that FR-005 mandates. Do **not** introduce a `packages/generacy → packages/orchestrator` import — the CLI deliberately avoids that direction today.

## Acceptance criteria

- Max inter-attempt reconnect delay is ≤ ~60s in both `SmeeWebhookReceiver` and `SmeeDoorbellSource`.
- Reconnect delays carry jitter (not a fixed doubling sequence).
- After a simulated outage that drives attempts to the cap, a client reconnects within the new cap once the endpoint recovers (unit test around `calculateBackoffDelay` / the reconnect loop).
- Changeset included.

## Context

Surfaced while diagnosing why `/cockpit:auto` idled between phases on the snappoll run — the #985 / #987 / #988 fixes all work; this is purely reconnect-latency to a flaky external service. The 300s auto-loop heartbeat remains the ultimate safety net; this change just restores the real-time path much faster after a transient blip. Related: #952 (provisioning), #987 (poll-gate), #988 (doorbell discovery).


## User Stories

### US1: Operator recovers from a transient smee.io blip in seconds, not minutes

**As an** operator running `/cockpit:auto` on a cluster whose webhook path is smee.io,
**I want** both smee SSE consumers (orchestrator receiver + cockpit doorbell) to reconnect within ~30s of smee.io recovering from a transient outage,
**So that** a brief upstream blip does not become a multi-minute real-time delivery outage that stalls the auto loop on its 300s heartbeat.

**Acceptance Criteria**:
- [ ] After a simulated smee outage that drives `reconnectAttempt` to the cap, the next reconnect fires within the new cap once the endpoint is healthy.
- [ ] Reconnect delays are randomised (jitter present) so a fleet of clients on the same channel does not stampede on recovery.
- [ ] Both `SmeeWebhookReceiver` and `SmeeDoorbellSource` use the same cap and jitter shape.
- [ ] Changeset included per the repo's CI gate.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `SmeeWebhookReceiver.MAX_BACKOFF_MS` is `30_000` (30s). | P1 | Was 300_000. |
| FR-002 | `SmeeDoorbellSource.MAX_BACKOFF_MS` is `30_000` (30s). | P1 | Was 300_000. Must match FR-001 exactly (single source of truth via FR-005). |
| FR-003 | Reconnect delay uses **equal jitter**: `delay = capped/2 + random(0, capped/2)` where `capped = min(base * 2^attempt, MAX_BACKOFF_MS)`. | P1 | Bounds output to `[capped/2, capped]`; never overshoots cap; never near-zero. |
| FR-004 | Base reconnect delay stays at `5_000` (5s) in both consumers. | P1 | Ladder becomes 5s → 10s → 20s → 30s(cap), each with equal jitter applied. |
| FR-005 | A single `calculateBackoffDelay(attempt, { base, cap })` helper is defined in one shared leaf package and imported by both `packages/orchestrator/src/services/smee-receiver.ts` and `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts`. | P1 | Prevents future drift. Placement: new leaf package (e.g. `packages/smee-backoff`) unless the plan phase identifies an existing leaf package that BOTH consumers already depend on (do NOT introduce a `generacy → orchestrator` import). |
| FR-006 | Jitter is applied at every attempt including `attempt=0`. The invariant is "pre-jitter base is 5s"; the post-jitter output at `attempt=0` may be anywhere in `[2.5s, 5s]`. | P1 | Prevents a synchronized thundering herd when a smee.io restart drops all clients simultaneously. |
| FR-007 | Regression test coverage is **both** (a) a pure unit test on `calculateBackoffDelay` asserting the pinned cap-attempt returns a value in the equal-jitter bound `[MAX/2, MAX]`, AND (b) a fake-timer test on at least one consumer's reconnect loop that pins `reconnectAttempt` at the cap, flips the fetch mock to succeed, and asserts the next reconnect fires within `MAX_BACKOFF_MS`. | P1 | Loop test guards the attempt-reset-on-success behaviour that this bug is actually about. |
| FR-008 | `reconnectAttempt` continues to reset to 0 on a successful connect (existing behaviour preserved). | P1 | Not a new requirement — asserted here so FR-007's loop test has an explicit invariant to guard. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Post-cap reconnect delay | ≤ 30_000 ms (equal-jitter bounded, so ≤ `MAX_BACKOFF_MS` exactly — never overshoots) | Unit test on `calculateBackoffDelay(N)` where N is any attempt at/above cap; assert `MAX_BACKOFF_MS/2 <= delay <= MAX_BACKOFF_MS`. |
| SC-002 | Real-time recovery latency after smee.io healthy | Reconnect fires within `MAX_BACKOFF_MS` (30s) of the endpoint returning to service. | FR-007 fake-timer loop test. |
| SC-003 | Cap + jitter parity across both consumers | Identical values (`MAX_BACKOFF_MS`, base, jitter algorithm) in receiver and doorbell. | Both consumers import from the single shared helper (FR-005); grep for stray `MAX_BACKOFF_MS` constants outside the shared module returns zero hits in both files. |
| SC-004 | No stampede on recovery | Two consecutive attempts (whether same client or fleet) do not produce identical delays. | Unit test: call `calculateBackoffDelay(attempt=3)` twice; assert results differ (probabilistic — use fixed RNG seed or repeat N times and assert variance > 0). |

## Assumptions

- The 300s auto-loop heartbeat and the orchestrator's safety-net poll remain in place as the ultimate backstop; this change only restores the real-time path faster after a blip.
- `MAX_BACKOFF_MS = 30_000` is acceptable upstream-load pressure during a genuinely long smee.io outage — smee.io is built for many reconnecting SSE clients, and a failed reconnect is a cheap connection attempt.
- Equal jitter's ±50% spread band is sufficient to de-sync a small fleet (orchestrator + a few doorbells on the same channel).
- No configuration surface (env var / cluster.yaml field) is needed for `MAX_BACKOFF_MS`; the constant lives in code. If a future need to tune it operationally appears, that is a follow-up.
- The `packages/smee-backoff` package name is a suggestion; the plan phase chooses the exact placement — either a new leaf package or an existing shared leaf package that both `packages/orchestrator` and `packages/generacy` already depend on.

## Out of Scope

- Reducing the 300s `/cockpit:auto` heartbeat (that is the *safety net*, not the primary path this fix targets).
- Replacing smee.io as the webhook transport (tracked separately in #952 provisioning work).
- Configurable / operator-tunable cap or jitter band (all three are hard-coded constants in the shared helper).
- Changes to the orchestrator's safety-net poll cadence or the doorbell's discovery path (#987, #988).
- Migrating either consumer off SSE / off the current fetch+ReadableStream implementation.

---

*Generated by speckit*
