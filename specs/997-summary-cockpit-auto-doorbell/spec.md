# Feature Specification: ## Summary

The `/cockpit:auto` doorbell dies mid-run — its stdout stream ends, the harness `Monitor` reports the sensor "completed", and the operator loop drops to the 5-minute heartbeat for the rest of a potentially hour-long run

**Branch**: `997-summary-cockpit-auto-doorbell` | **Date**: 2026-07-18 | **Status**: Draft

## Summary

## Summary

The `/cockpit:auto` doorbell dies mid-run — its stdout stream ends, the harness `Monitor` reports the sensor "completed", and the operator loop drops to the 5-minute heartbeat for the rest of a potentially hour-long run. Two things in the runtime source-selection logic are wrong:

1. On smee loss the doorbell **demotes to poll-fallback and the process then exits**, instead of simply continuing to re-establish the smee.io connection.
2. The demotion thresholds are far too aggressive for real workloads — a **5-minute "no success" window** and **5 consecutive reconnect failures (~95s)** — so they trip during the normal quiet periods of long-running steps. Planning/implementation for large issues routinely run 30+ minutes; an oversized issue (that arguably should have been an epic) has taken ~1 hour with no webhook events in between.

**Observed** (snappoll #1, 2026-07-18): doorbell came up `source=smee reason=startup-smee-selected`, smee.io had a blip, it demoted `source=poll-fallback reason=smee-runtime-lost`, emitted its snapshot, and the **process exited** ("stream ended") with no error on stderr. Per agency#431's passive policy the skill did not re-arm it → heartbeat-only for the remainder.

## Root cause — `packages/generacy/src/cli/commands/cockpit/doorbell/source-selector.ts`

- **5-minute silence demotion.** `DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS = 300_000` (line 30) + `observeElapsed()` (lines 120-128): while `smee-active`, if `now - lastSuccessfulConnectAt > 5 min` → `transition('poll-fallback', 'smee-runtime-lost')`. **`lastSuccessfulConnectAt` is refreshed only on a (re)connect (`onReconnectSuccess`, line 101), never while a healthy SSE connection stays open** — so a stable-but-quiet connection is wrongly declared lost after 5 minutes. This directly punishes long, event-quiet steps.
- **Trigger-happy failure demotion.** `DEFAULT_DEMOTE_AFTER_FAILURES = 5` (line 29) + `onReconnectAttempt` (lines 89-96): 5 consecutive reconnect failures → demote. With #991's backoff ladder (5→10→20→30→30s) that is ~95s of a transient smee.io blip before giving up on smee.
- **Demotion exits the process.** The demotion fires `onModeChange('poll-fallback')`; the handler in `doorbell.ts` emits the poll snapshot and then the process's stdout stream ends (the sensor dies). The `SmeeDoorbellSource.runLoop` already reconnects forever on its own, so runtime demotion is not needed to keep events flowing — and it must never end the process.

## Requested behaviour (per operator directives)

1. **The doorbell process must never exit on smee loss.** When the smee.io connection drops it must keep re-establishing it indefinitely (bounded backoff + jitter per #991). Losing smee is a reconnect condition, not a terminate condition.
2. **Do not treat a quiet-but-open connection as "smee lost."** Remove the 5-minute `demoteAfterMsWithoutSuccess` (or raise it far beyond any realistic step duration). If a liveness signal is desired, refresh it on SSE keepalives / any received bytes — not only on reconnect. A healthy connection can legitimately deliver zero events for 30–60 minutes.
3. **Favour smee over poll-fallback at runtime.** Runtime demotion should at most be a live bridge that continuously retries smee re-promotion — never a terminal state and never a process exit. Poll-fallback remains valid only for genuinely smee-less clusters selected at startup (`startup-no-channel`).

## Acceptance criteria

- The doorbell survives arbitrary-length smee.io outages **and** quiet periods (≥60 min) without its stdout stream ending; the `Monitor` sensor stays alive for the epic's full duration.
- A stable, open, event-quiet smee connection is **not** demoted (no `smee-runtime-lost` from silence alone).
- A transient smee.io drop yields continued reconnect attempts (bounded backoff+jitter), never a give-up-and-exit.
- Regression tests: (a) 60-minute quiet smee connection → no demotion, no exit; (b) smee drop → reconnect → resume real-time, process never exits.
- Changeset included.

## Related / secondary

Compounding skill-side policy: agency#431's passive no-re-spawn means once the sensor dies it stays dead (heartbeat-only) for the rest of the run. Making the engine resilient per above makes deaths rare, but re-arming the sensor on death (auto.md, or on the heartbeat) is worth considering as defense-in-depth — separate agency change. Upstream trigger is smee.io flakiness (#991 sped up reconnects; this issue stops the give-up + exit). Related: #978 (source selector origin), #982 (doorbell retriable exits), #991 (reconnect backoff).


## User Stories

### US1: Long, event-quiet step keeps a live doorbell

**As an** operator running `/cockpit:auto` against a long-running epic,
**I want** the doorbell sensor to stay alive during 30–60+ min quiet windows on a stable smee connection,
**So that** the operator loop keeps receiving real-time events instead of dropping to the 5-min heartbeat for the rest of the run.

**Acceptance Criteria**:
- [ ] A `smee-active` connection that keeps receiving smee.io keepalive comments (no event payloads) for ≥60 min does not demote and the sensor's stdout stream does not end.
- [ ] The `Monitor` harness continues to observe the sensor as alive for the epic's full duration.

### US2: Transient smee.io outage does not kill the sensor

**As an** operator during a smee.io blip mid-run,
**I want** the doorbell process to keep re-establishing the SSE connection indefinitely (bounded backoff + jitter per #991) instead of exiting,
**So that** momentary upstream flakiness never terminates the sensor for the remainder of the run.

**Acceptance Criteria**:
- [ ] N consecutive reconnect failures (current default 5) do NOT terminate the process; instead, the doorbell opens the live poll-fallback bridge while `SmeeDoorbellSource.runLoop` keeps reconnecting smee in the background.
- [ ] On smee recovery, the doorbell re-promotes from `poll-fallback` back to `smee-active` without a process restart.
- [ ] The process's stdout stream never ends as a result of runtime smee loss (of any cause: failure count, silence heuristic, timeouts).

### US3: Dead-but-open SSE stream is still detected

**As an** operator whose smee connection is half-open (TCP alive, keepalives stopped),
**I want** the doorbell to detect the dead stream and react non-terminally,
**So that** we don't silently sit on a socket that will never deliver another byte.

**Acceptance Criteria**:
- [ ] If inbound SSE bytes (keepalive comments OR event payloads) stop for longer than a small multiple of the smee.io keepalive interval, the doorbell reacts by reconnecting and, if reconnect fails per US2, drops to the live poll-fallback bridge.
- [ ] The reaction is never a process exit.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The doorbell process MUST NOT exit on smee loss from any cause (failure count, silence heuristic, timeouts). Losing smee is a reconnect condition, never a terminate condition. | P0 | Core bug fix. Per Q2=B. |
| FR-002 | The silence-demotion heuristic (`demoteAfterMsWithoutSuccess`) MUST be retained but with `lastSuccessfulConnectAt` refreshed on ANY inbound SSE bytes — both smee.io keepalive comments and event payloads. Threshold MUST be a small multiple of the smee.io keepalive interval (NOT scaled to step duration). Ideally the byte-liveness lives in `SmeeDoorbellSource` (the connection owner), not the selector. | P0 | Per Q1=B. Keeps the dead-socket detector alive; kills the false-positive on quiet-but-alive streams. |
| FR-003 | `DEFAULT_DEMOTE_AFTER_FAILURES` and its `onReconnectAttempt` guard MUST remain, but the resulting transition MUST be strictly non-terminal — demote to the FR-004 live bridge, never exit. Threshold value may be relaxed but is not critical once the transition is non-terminal. | P1 | Per Q3=B. |
| FR-004 | Runtime demotion to `poll-fallback` MUST be a strictly non-terminal LIVE BRIDGE: stdout stays open emitting poll snapshots while `SmeeDoorbellSource.runLoop` keeps reconnecting smee in the background; the `rePromoteTimer` machinery re-promotes to `smee-active` on recovery. This applies to demotions from FR-002 (silence) and FR-003 (failure count) alike. | P0 | Per Q2=B. Preserves ~30s poll latency during a smee outage instead of dropping to the 5-min heartbeat. |
| FR-005 | Startup source selection remains unchanged: if the initial `startSmeeMode` returns `transient-fail` (discovery non-null, first connect never succeeds), the doorbell falls through to poll-mode as today. | P1 | Per Q4=A. |
| FR-006 | The startup poll-fallback path MUST use the SAME non-terminal live bridge as FR-004 (re-promote machinery retained), so a startup-poll doorbell recovers to smee and never dead-ends. | P0 | Per Q4=A requirement. Without this, removing the runtime demotion strand would strand startup-poll doorbells. |
| FR-007 | Regression tests MUST cover: (a) a ≥60-minute quiet `smee-active` connection with periodic keepalive bytes → no demotion, no process exit; (b) keepalives STOP mid-run → liveness heuristic fires → demote to live bridge + retry smee, still no exit; (c) N consecutive reconnect failures during a smee.io drop → live bridge opens, smee eventually reconnects, re-promotion to `smee-active`, process never exits. | P0 | Per Q5=B. Use `vi.useFakeTimers()` to drive both `Date.now()` and the `elapsedTicker` interval together. |
| FR-008 | A changeset MUST be included in the PR (patch bump for `@generacy-ai/generacy` — defect fix under `workflow:speckit-bugfix`). | P0 | Per CI gate documented in CLAUDE.md. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Doorbell survival across a ≥60-min quiet smee window | 100% (stdout stream open, sensor alive) | Regression test FR-007(a) passes in CI. |
| SC-002 | Doorbell survival across a transient smee.io drop (reconnect failures ≥ N) | 100% (no process exit, re-promotion on recovery) | Regression test FR-007(c) passes in CI. |
| SC-003 | Dead-stream detection latency | Demotion fires within a small multiple of the smee.io keepalive interval after keepalives stop | Regression test FR-007(b) passes in CI. |
| SC-004 | Zero `smee-runtime-lost → process exit` code paths | 0 occurrences | Audit: no code path emits the poll snapshot AND terminates the process. |
| SC-005 | Operator-loop heartbeat frequency during a long run | Never falls back to the 5-min heartbeat solely due to a live-but-quiet smee connection | Manual `/cockpit:auto` run against a long epic; check for continuous doorbell events. |

## Assumptions

- smee.io emits periodic keepalive comments (SSE `:` lines) on healthy connections; FR-002's byte-liveness signal depends on this. If smee.io ever stops sending keepalives on healthy connections, the liveness threshold would trigger false-positives — mitigated by non-terminal transition (FR-004) so the worst case is a poll-bridge open + re-promote, not a dead sensor.
- #991's bounded reconnect backoff + jitter is in place and continues to govern `SmeeDoorbellSource.runLoop` reconnects.
- The `rePromoteTimer` machinery in `source-selector.ts:150-195` and the `onModeChange('poll-fallback')` branch at `doorbell.ts:483-497` remain in the codebase — this spec makes them non-terminal, not removes them.

## Out of Scope

- Skill-side re-arming policy (agency#431's passive no-re-spawn). Defense-in-depth via `auto.md` or the heartbeat is worth considering separately, but engine resilience per this spec makes deaths rare enough that the skill change is not required to close this issue.
- Changes to the reconnect backoff ladder itself (owned by #991).
- Changes to startup source selection semantics beyond FR-005's preserve-as-today requirement.
- Removal of the `poll-fallback` mode. It remains valid for startup-selected paths (FR-005) and as the runtime live bridge (FR-004).

---

*Generated by speckit*
