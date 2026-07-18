# Feature Specification: smee SSE reconnect cap + jitter (receiver + doorbell)

**Branch**: `991-summary-both-smee-sse` | **Date**: 2026-07-18 | **Status**: Draft
**Issue**: [#991](https://github.com/generacy-ai/generacy/issues/991)
**Workflow**: `workflow:speckit-bugfix`

## Summary

Both smee SSE consumers — the orchestrator's `SmeeWebhookReceiver` and the cockpit doorbell's `SmeeDoorbellSource` — use an exponential reconnect backoff capped at **5 minutes**. After a transient smee.io outage the backoff climbs to that cap, so even once smee.io is healthy again a client can sit disconnected for up to 5 more minutes before its next reconnect attempt. During that window the orchestrator falls back to its safety-net poll and the operator `/cockpit:auto` doorbell goes silent (auto loop drops to its 300s heartbeat). A brief upstream blip becomes a multi-minute real-time outage.

The cap is a legitimate anti-hammer guard, but 5 minutes is far too long for a transport whose purpose is low-latency delivery. Most smee blips last seconds-to-a-minute; the cap turns them into up-to-5-min stalls. `reconnectAttempt` already resets to 0 on a successful connect, so the only issues are (a) the ceiling and (b) the lack of jitter — a fleet of clients on the same channel currently reconnects in lockstep.

## Evidence

Snappoll preview cluster, 2026-07-18. smee.io returned `500 Internal Server Error` / `fetch failed` for ~15 min; the orchestrator's reconnect ladder climbed to and pinned at the cap:

```
Smee connection failed: 500 Internal Server Error   attempt 5   reconnectMs 160000
Smee connection failed: 500 Internal Server Error   attempt 6   reconnectMs 300000
Smee connection failed: 500 Internal Server Error   attempt 7   reconnectMs 300000
Connected to smee.io channel                         ← finally recovered
```

Session-wide the orchestrator processed 38 webhook events vs 1671 poll — smee delivery was effectively down for most of the run, and recovery was gated by the 5-min cap. The `/cockpit:auto` operator doorbell (same channel) idled on its 300s heartbeat between phases: the observed "it has work to do but goes to sleep waiting for a wake" behaviour.

## Root cause

Two near-verbatim copies of the same ladder — the doorbell source explicitly models its ladder on the receiver:

- `packages/orchestrator/src/services/smee-receiver.ts:69` — `private static readonly MAX_BACKOFF_MS = 300000; // 5 minutes`. `:495-497` — `delay = baseReconnectDelayMs * Math.pow(2, attempt)` then `Math.min(delay, MAX_BACKOFF_MS)`. Base default ~5000ms. Ladder: 5s → 10s → 20s → 40s → 80s → 160s → **300s (cap)**.
- `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts:29-30` — `DEFAULT_BASE_RECONNECT_DELAY_MS = 5_000`, `MAX_BACKOFF_MS = 300_000`. `:219-222` — same formula.

Neither computes jitter around the resulting delay.

## User Stories

### US1: Operator whose cluster survives a smee.io blip

**As a** cluster operator whose smee.io upstream has a transient 30s–2min outage during a `/cockpit:auto` run,
**I want** the orchestrator's `SmeeWebhookReceiver` to re-establish the SSE connection within ~30–60s of smee.io recovering,
**So that** real-time webhook delivery resumes promptly and the cluster stops burning App-installation-token GraphQL polls beyond the actual outage window.

**Acceptance Criteria**:
- [ ] After a simulated smee.io outage that drives `reconnectAttempt` to the cap, once the endpoint recovers the receiver reconnects on the next scheduled attempt within the new cap (≤ ~60s), not up to 5 minutes.
- [ ] `Connected to smee.io channel` appears in orchestrator logs within one cap-interval of endpoint recovery.

### US2: Operator running `/cockpit:auto` whose doorbell rides the same channel

**As an** operator running `/cockpit:auto`,
**I want** the cockpit doorbell (`SmeeDoorbellSource`) to reconnect on the same cap as the orchestrator receiver,
**So that** phase-complete wakes resume within ~30–60s of smee.io recovering rather than the loop having to fall through to its 300s heartbeat.

**Acceptance Criteria**:
- [ ] The doorbell reconnect ladder maxes at the same cap as the receiver (they use identical constants).
- [ ] After a simulated outage that pins the doorbell at the cap, the doorbell reconnects within the new cap once smee.io recovers.

### US3: Fleet of clients on the same channel avoiding a thundering herd

**As an** operator running an orchestrator + one or more doorbells on the **same** smee channel,
**I want** each client's reconnect delay to carry jitter,
**So that** when smee.io recovers the clients don't reconnect in lockstep against a just-recovered endpoint.

**Acceptance Criteria**:
- [ ] Successive computed reconnect delays for a given attempt count are not identical run-to-run — a jitter component is applied.
- [ ] Jitter is bounded so the effective delay stays within a documented range around the exponential value.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `SmeeWebhookReceiver.MAX_BACKOFF_MS` is lowered from `300_000` to a value ≤ `60_000` (target 30–60s). The ladder becomes 5s → 10s → 20s → cap. | P1 | `packages/orchestrator/src/services/smee-receiver.ts:69` |
| FR-002 | `SmeeDoorbellSource.MAX_BACKOFF_MS` is lowered from `300_000` to the same value as FR-001. | P1 | `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts:29-30` |
| FR-003 | Both consumers apply **jitter** to each computed reconnect delay (e.g. ±20–50% randomisation) so a fleet of clients on the same channel does not reconnect in lockstep. | P1 | Applied at both call sites |
| FR-004 | The base reconnect delay stays at ~5s in both consumers. This change modifies only the cap and jitter. | P1 | Backwards-compatible with fast-recovery behaviour |
| FR-005 | The reconnect logic is factored into a single shared helper (e.g. `calculateBackoffDelay(attempt, opts)`) consumed by both `SmeeWebhookReceiver` and `SmeeDoorbellSource`, so future changes cannot drift between the two copies. | P1 | Two near-verbatim copies today; consolidate to prevent recurrence |
| FR-006 | A unit test exercises the shared helper: verifies (a) the ladder monotonically climbs to the cap, (b) the cap is never exceeded, (c) jitter produces non-identical delays for the same attempt across repeated calls, and (d) `reconnectAttempt=0` produces the base delay. | P1 | Covers the core invariants |
| FR-007 | A regression test simulates the recovery path: after `reconnectAttempt` pins at the cap and the endpoint recovers, the next reconnect attempt fires within the new cap. | P1 | Guards against the observed 5-min stall |
| FR-008 | A `.changeset/*.md` file is included in the PR: `patch` bump for `@generacy-ai/orchestrator` and `@generacy-ai/generacy` (bugfix workflow, no new capability). | P1 | Changeset CI gate |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Max inter-attempt reconnect delay in either consumer | ≤ 60s (excluding jitter overshoot; net max ≤ ~90s with a +50% jitter band on a 60s cap) | Read `MAX_BACKOFF_MS` constants directly; unit-test assertion on `calculateBackoffDelay` output |
| SC-002 | Time from smee.io endpoint recovery to `Connected to smee.io channel` log line, given a client pinned at the cap | ≤ 1 × cap (~60s) | Simulated recovery test in unit / integration; log-timing observation on preview cluster |
| SC-003 | Distinct backoff values produced across a run of clients on the same channel for the same attempt count | > 1 (i.e. jitter observed) | Unit test: call helper N times for `attempt=k`, assert not-all-equal |
| SC-004 | Static grep for `300000` or `300_000` as a `MAX_BACKOFF_MS` / reconnect-cap constant in `packages/orchestrator/src/services/smee-receiver.ts` and `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` | 0 hits | `grep -n "300_000\|300000" <files>` post-change |
| SC-005 | Number of distinct copies of the backoff-computation formula (`base * 2^attempt` + cap) in the smee-consumer code paths | 1 (shared helper) | Grep; import-graph inspection |

## Assumptions

- The 5s base reconnect delay in both consumers is appropriate and should not change. Only the cap and jitter behaviour change.
- `reconnectAttempt` resets to 0 on a successful connect in both consumers (verified in the issue). No change to the reset semantics.
- A cap in the 30–60s range is short enough to restore real-time delivery promptly after common blips and long enough to remain an effective anti-hammer guard for extended outages (during which callers still have the safety-net poll / 300s heartbeat).
- The shared helper can live in one of the two existing packages (e.g. `packages/orchestrator` re-exported to CLI, or a small shared utility). Exact placement is a plan-phase decision.
- Jitter can be implemented with `Math.random()` — cryptographic RNG is not needed for this purpose.
- No existing test asserts an exact deterministic ladder value that would break under jitter; if any do, they get updated to assert a range.

## Out of Scope

- Changing the base reconnect delay (stays ~5s).
- Changing `reconnectAttempt` reset semantics.
- Any change to the smee.io endpoint contract, webhook registration path, or fallback poll cadence — this is purely reconnect-latency tuning.
- The 300s `/cockpit:auto` heartbeat itself. It remains the ultimate safety net; this change just restores the real-time path faster after a transient blip.
- Companion cloud-side or provisioning changes. Related but separate: #952 (provisioning), #987 (poll-gate), #988 (doorbell discovery).
- Alternative real-time transports (SSE-over-cloud, WebSocket) — deferred.

---

*Generated by speckit*
