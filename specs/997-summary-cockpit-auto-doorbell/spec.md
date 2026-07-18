# Feature Specification: Doorbell must survive smee loss and event-quiet periods without exiting

**Branch**: `997-summary-cockpit-auto-doorbell` | **Date**: 2026-07-18 | **Status**: Draft
**Issue**: [#997](https://github.com/generacy-ai/generacy/issues/997) (`workflow:speckit-bugfix`)

## Summary

The `/cockpit:auto` doorbell dies mid-run: its stdout stream ends, the harness `Monitor`
reports the sensor "completed", and the operator loop drops to the 5-minute heartbeat
for the remainder of a potentially hour-long epic. The bug lives in the runtime
source-selection state machine at
`packages/generacy/src/cli/commands/cockpit/doorbell/source-selector.ts`. Two independent
mistakes conspire to end the process:

1. **On smee loss the doorbell demotes to `poll-fallback` and the process then exits**
   instead of continuing to re-establish the smee.io connection. The `SmeeDoorbellSource.runLoop`
   already reconnects forever on its own — runtime demotion is not needed to keep events
   flowing, and it must never end the process.
2. **The demotion thresholds are far too aggressive for real workloads.** The 5-minute
   "no-success" window (`DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS = 300_000`) and the
   5-consecutive-reconnect-failure limit (~95 s given #991's 5→10→20→30→30 s backoff
   ladder) trip during the normal quiet periods of long-running phases. Planning and
   implementation for large issues routinely run 30+ minutes; an oversized issue has
   already been observed to run ~60 min with no webhook events between them.

Additionally, `lastSuccessfulConnectAt` is refreshed **only** on a (re)connect
(`onReconnectSuccess`, line 101) — never while a healthy SSE connection stays open — so
a stable-but-quiet connection is wrongly declared "lost" after 5 minutes of silence.

### Observed incident

2026-07-18, snappoll #1 during a long-running epic:

- Doorbell came up `source=smee reason=startup-smee-selected`.
- smee.io had a transient blip.
- Selector emitted `source=poll-fallback reason=smee-runtime-lost`.
- Poll snapshot emitted; `stdout` stream ended; harness `Monitor` marked the sensor
  "completed"; no error on stderr.
- Per agency#431's passive re-arm policy the skill did not re-spawn the sensor →
  heartbeat-only for the remainder of the run.

## Goals

- The doorbell process must never exit on smee loss. Losing smee is a reconnect
  condition, not a terminate condition.
- Do not treat a quiet-but-open connection as "smee lost." Silence over any realistic
  step duration (≥60 min) must not demote.
- Favour smee over poll-fallback at runtime. Runtime demotion at most becomes a live
  bridge that continuously retries smee re-promotion — never terminal and never a
  process exit. Poll-fallback remains valid only for genuinely smee-less clusters
  selected at startup (`reason=startup-no-channel`).

## Non-Goals

- Skill-side re-arm on sensor death (agency#431) — worth revisiting once the engine is
  resilient, but out of scope for this issue.
- Changes to the smee.io reconnect backoff ladder itself (owned by #991).
- Changes to the startup source-selection decision (owned by #978).

## User Stories

### US1 — Long-running epic keeps its real-time wake source (P1)

**As an** operator running `/cockpit:auto` on a large epic that takes 30–60+ minutes,
**I want** the doorbell to stay alive and deliver real-time bus events for the entire
run, **so that** the operator loop reacts to gate transitions in seconds rather than
waiting for the next 5-minute heartbeat.

**Acceptance Criteria**

- The doorbell process's `stdout` stream stays open for the full epic duration, even
  through silence periods of ≥60 minutes.
- The harness `Monitor` reports the sensor as still-running for the epic's full
  duration.
- No `source=poll-fallback reason=smee-runtime-lost` line is emitted purely due to
  a quiet-but-open smee connection.

### US2 — Transient smee.io blip does not degrade the sensor (P1)

**As an** operator, **I want** the doorbell to ride out smee.io outages by
reconnecting indefinitely, **so that** upstream provider flakiness does not silently
degrade my run to heartbeat-only mode.

**Acceptance Criteria**

- On a smee.io connection drop, the doorbell reconnects with the bounded backoff +
  jitter established by #991.
- No number of consecutive reconnect failures ends the process.
- Once smee.io recovers, real-time events resume without operator action.

### US3 — Genuinely smee-less clusters are unaffected (P2)

**As an** operator on a cluster that has no smee channel configured at all,
**I want** the doorbell to keep using poll-fallback as it does today, **so that**
this bugfix does not regress the smee-less path.

**Acceptance Criteria**

- Clusters starting with `reason=startup-no-channel` continue to run in poll-fallback
  and exhibit the same behaviour as before this change.
- Startup source selection is unchanged.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                                | Priority | Notes |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----- |
| FR-001 | Runtime demotion from a `smee-active` connection MUST NOT cause the doorbell process to exit. The `stdout` stream MUST remain open and the harness `Monitor` MUST continue to see the sensor as alive.                                                                                                     | P1       | Root cause 3 in issue #997. |
| FR-002 | A stable-but-quiet `smee-active` connection MUST NOT be demoted on silence alone. Either the `demoteAfterMsWithoutSuccess` heuristic is removed entirely, or its liveness signal is refreshed on any inbound bytes (SSE keepalives / events) — not only on a full reconnect.                                | P1       | Root cause 1 + 2 in issue #997. |
| FR-003 | A transient smee.io outage MUST result in continued reconnect attempts using #991's bounded backoff + jitter. No number of consecutive reconnect failures MAY end the process. The `DEFAULT_DEMOTE_AFTER_FAILURES` heuristic must not terminate the sensor.                                                 | P1       | Root cause 2 in issue #997. |
| FR-004 | If runtime demotion to `poll-fallback` is retained at all, it MUST behave as a live bridge that continuously retries smee re-promotion in the background — never terminal, never a process exit. Alternatively, runtime demotion may be removed altogether if it is no longer load-bearing.                | P1       | Operator directive #3. |
| FR-005 | The startup source-selection path is unchanged: `startup-no-channel` clusters continue to poll-fallback; `startup-smee-selected` clusters continue to attempt smee first.                                                                                                                                    | P2       | Boundary with #978. |
| FR-006 | The one-line-per-transition `source=… reason=…` stderr contract (from #978) is preserved for all transitions that still fire. Removed transitions simply stop emitting.                                                                                                                                     | P2       | Preserve observability. |
| FR-007 | Regression tests MUST cover: (a) a ≥60-minute quiet `smee-active` connection produces no demotion and no exit; (b) a smee drop followed by reconnect resumes real-time events, and the process never exits.                                                                                                | P1       | Acceptance-criterion tests from #997. |
| FR-008 | A changeset entry MUST be added (see repository CLAUDE.md — CI gates on `packages/*/src/` changes without a new `.changeset/*.md`). Bump level `patch` (`workflow:speckit-bugfix`).                                                                                                                          | P1       | Ships as `@generacy-ai/generacy` patch. |

## Success Criteria

| ID      | Metric                                                                                                       | Target                                                                                                                                        | Measurement |
| ------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| SC-001  | Doorbell sensor lifetime under a ≥60 min event-quiet smee connection.                                        | Sensor still alive at 60 min; no `smee-runtime-lost` line emitted.                                                                            | Regression test (a) in FR-007. |
| SC-002  | Doorbell process exit rate on smee.io transient drops.                                                       | Zero — the process must not exit for any smee-related runtime event.                                                                          | Regression test (b) in FR-007 + code-path audit that no `smee-runtime-lost` branch reaches `process.exit` or ends `stdout`. |
| SC-003  | Real-time event delivery latency after smee.io recovery.                                                     | Bounded by #991's backoff ladder (≤ ~30 s in steady state); no operator action required.                                                      | Regression test (b) in FR-007. |
| SC-004  | Behaviour on `startup-no-channel` clusters.                                                                  | Byte-for-byte unchanged from pre-fix behaviour (poll-fallback from startup, same cadence).                                                    | Existing source-selector tests continue to pass without modification for the `initial: 'poll-fallback'` path. |

## Assumptions

- The `SmeeDoorbellSource` reconnect loop (post-#991) is genuinely infinite: given the
  bounded-backoff-with-jitter contract, it will reconnect indefinitely without external
  intervention. This spec relies on that contract holding.
- The harness `Monitor` interprets `stdout` stream end as sensor death. Any change that
  keeps the process running but closes `stdout` (e.g. via an intermediate stream
  wrapper) would need to be avoided for the same reason.
- The `source=… reason=…` stderr line is the sole external contract from #978 that
  downstream consumers depend on; removing the `smee-runtime-lost` line entirely (if
  the transition is removed) is acceptable so long as no other transition's line is
  changed.

## Out of Scope

- Skill-side re-arm of a dead sensor (agency#431 — separate agency change; recommended
  as defense-in-depth once the engine no longer sheds sensors, but not required to
  close this issue).
- Any change to smee.io reconnect backoff, jitter, or ceiling (owned by #991).
- Any change to startup source-selection (owned by #978).
- Any change to the doorbell's poll-fallback cadence or content.

## Related

- #978 — Source selector origin (introduces the runtime source-selection state machine).
- #982 — Doorbell retriable exits.
- #991 — Reconnect backoff (raises the reconnect ladder speed but does not stop the
  give-up-and-exit; that is this issue).
- agency#431 — Skill-side passive re-arm policy (compounding factor; separate repo).

---

*Generated by speckit — hand-edited to reflect the details of issue #997.*
