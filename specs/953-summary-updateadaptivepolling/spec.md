# Feature Specification: Engage adaptive polling for the three monitor services when no webhook path exists

**Branch**: `953-summary-updateadaptivepolling` | **Date**: 2026-07-16 | **Status**: Clarified
**Issue**: [#953](https://github.com/generacy-ai/generacy/issues/953) — `workflow:speckit-bugfix`

## Summary

`updateAdaptivePolling()` treats "no webhook event has *ever* arrived" as healthy and returns
before the elapsed-time check runs. Because `state.lastWebhookEvent` is only ever written by a
`SmeeWebhookReceiver` (or a direct HTTP webhook route, for PR feedback), a service on a cluster
with no configured smee channel keeps `lastWebhookEvent === null` for its entire lifetime. The
adaptive-polling safety net therefore never engages for the exact population it exists to
protect: clusters with no real-time event path.

Confirmed on the `snappoll` cluster — `intervalMs: 30000` at startup, no smee receiver, interval
never adapts.

**Three services carry the identical dead-branch bug**, established by clarification (Q4):

| Service | Where | Feeder | Symptom |
|---|---|---|---|
| `LabelMonitorService` | `label-monitor-service.ts:589` | `SmeeWebhookReceiver` (typed to this service) | Dead on smee-less clusters |
| `PrFeedbackMonitorService` | `pr-feedback-monitor-service.ts:757` | Direct HTTP route `pr-webhooks.ts:119` only (smee never feeds it) | Dead on any cluster reachable via smee (i.e. the smee-less population #952 creates) |
| `MergeConflictMonitorService` | `merge-conflict-monitor-service.ts:346` | `recordWebhookEvent()` has **no callers anywhere in the codebase** | Dead unconditionally, on every cluster in every configuration |

Two states are being conflated by the current early-return:

- **Smee/webhook configured, no events yet** — genuinely ambiguous; the channel may just be quiet.
- **No webhook feeder at all** — unambiguous; webhooks are definitively not working and will not
  start without a config change. Knowable at construction time.

Additionally, when smee **is** configured on `LabelMonitorService`, `server.ts:469-471` sets
`adaptivePolling: false` and uses `config.smee.fallbackPollIntervalMs`. So adaptive polling is
only ever *live* in the no-smee case — i.e., the exact case the early return silently disables.
As written, the `adaptivePolling` flag has no reachable effect at all.

## User Stories

### US1: Cluster operator whose webhooks were never configured (P1)

**As a** cluster operator running a freshly provisioned cluster with no smee channel,
**I want** the orchestrator's label-monitor loop to detect that webhooks are not delivering and
poll GitHub at the faster adaptive interval from the outset,
**So that** issue-label transitions are picked up on the order of seconds instead of the base
30-second interval, and the safety-net behavior that already exists in code actually runs.

**Acceptance Criteria**:
- [ ] A cluster started with no `config.smee.channelUrl` polls at the fixed-fast interval
      (`basePollIntervalMs / ADAPTIVE_DIVISOR`, clamped to `MIN_POLL_INTERVAL_MS`) from cycle 1
      onward, with no startup grace (Q1=A, Q2=A).
- [ ] The `updateAdaptivePolling()` runtime "adaptation" is a no-op on this branch — the
      interval is set once at construction and does not change (Q1=A).
- [ ] The signal driving this behaviour is a new `webhooksConfigured: boolean` field on
      `MonitorState`, set once at construction; `webhookHealthy` continues to mean "the
      configured webhook path is currently delivering" (Q5=A).
- [ ] Structured log line at construction confirms `{ webhooksConfigured: false, intervalMs: <fast> }`,
      distinct from the existing "webhooks appear unhealthy" transition (FR-004).
- [ ] Operator opt-out: when `adaptivePolling === false` on a smee-less cluster, the service
      polls at `basePollIntervalMs` indefinitely (Q3=A). Two reachable, distinct behaviours
      make `adaptivePolling` no longer dead code.
- [ ] Behaviour of clusters that **do** have a configured smee channel is unchanged —
      `adaptivePolling` remains `false` for them and `SmeeWebhookReceiver.recordWebhookEvent()`
      keeps driving `webhookHealthy`.

### US2: Cluster whose smee channel later fails (P2)

**As a** cluster operator running a cluster that once had a working webhook,
**I want** the existing elapsed-time detection to keep working when webhooks go silent,
**So that** the loss-of-service case (smee configured but not delivering) continues to be
covered by the same adaptive-polling mechanism.

**Acceptance Criteria**:
- [ ] After a webhook has been recorded and then no further webhooks arrive for
      `basePollIntervalMs * 2`, poll frequency increases (existing behavior preserved).
- [ ] `recordWebhookEvent()` still restores `basePollIntervalMs` on webhook recovery.

### US3: Twin services with the same dead branch (P1)

**As a** cluster operator running a smee-less cluster,
**I want** `PrFeedbackMonitorService` and `MergeConflictMonitorService` to engage the same
fixed-fast interval as `LabelMonitorService` when no webhook path exists,
**So that** PR-feedback labels and merge-conflict resolution work at the same latency as issue
labels, and the copy-pasted dead branches in these two services don't silently continue to
poll at the base interval (or, for `MergeConflictMonitorService`, at the base interval on
**every** cluster — see summary).

**Acceptance Criteria**:
- [ ] All three services accept a `webhooksConfigured` construction input and route through the
      same shared helper.
- [ ] Per-service constants (`ADAPTIVE_DIVISOR`, `MIN_POLL_INTERVAL_MS`) are preserved — the
      helper takes divisor and clamp as parameters, not constants. Documented divergence at
      `pr-feedback-monitor-service.ts:40` (LabelMonitor=3 vs PrFeedback=2) is intentional and
      must not be normalised away.
- [ ] The regression test (FR-007) lives against the shared helper, with a thin per-service
      test asserting each passes its own divisor through.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                | Priority | Notes                                                                                                                        |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|------------------------------------------------------------------------------------------------------------------------------|
| FR-001 | All three monitor services (`LabelMonitorService`, `PrFeedbackMonitorService`, `MergeConflictMonitorService`) MUST distinguish "webhooks not configured" from "webhooks configured but quiet".                                             | P1       | Q4=C: scope extended from LabelMonitor-only to all three. Signal is knowable at construction time from `config.smee.channelUrl` / equivalent per service. |
| FR-002 | When `webhooksConfigured === false`, the service MUST skip runtime adaptive polling entirely and use a fixed-fast interval computed once at construction: `basePollIntervalMs / ADAPTIVE_DIVISOR`, clamped to `MIN_POLL_INTERVAL_MS`. `updateAdaptivePolling()` MUST be a no-op on this branch. Engagement is immediate — no startup grace. | P1 | Q1=A, Q2=A. "No adaptation" is the honest model when the signal is a constructor-time constant. |
| FR-003 | When webhooks are configured (a `SmeeWebhookReceiver` is constructed, or the direct HTTP webhook route for PR feedback is live), behavior MUST remain unchanged: existing `adaptivePolling` / `fallbackPollIntervalMs` / `recordWebhookEvent()` semantics preserved. | P1 | Preserves `server.ts:469-471` and the PR-feedback direct-HTTP path verbatim.                                                 |
| FR-004 | Each service MUST emit a structured log line at construction when `webhooksConfigured === false`, with fields `{ webhooksConfigured: false, intervalMs: <computed>, reason: 'webhooks-not-configured' }` — distinct from the existing "webhooks appear unhealthy" transition. | P2       | Q5=A: log fields come off the new `webhooksConfigured` state field.                                                          |
| FR-005 | The `adaptivePolling: boolean` flag MUST have reachable, distinct effects. Specifically: on a smee-less cluster, `adaptivePolling: true` → fixed-fast interval (FR-002), `adaptivePolling: false` → `basePollIntervalMs` indefinitely (operator opt-out).                                             | P2       | Q3=A. Two distinct behaviours, both reachable — flag is no longer dead code. `fallbackPollIntervalMs` is not used here (it's the smee-configured cadence). |
| FR-006 | The fix MUST NOT alter each service's `MIN_POLL_INTERVAL_MS` or `ADAPTIVE_DIVISOR` values. Divergence between services (LabelMonitor=3, PrFeedback=2, MergeConflict=2) is intentional (documented at `pr-feedback-monitor-service.ts:40`) and MUST be preserved. The shared helper takes divisor and clamp as **parameters**, not constants. | P2 | Q4=C: the helper is a mechanism, not a policy setter. Callers own their constants.                                            |
| FR-007 | A shared helper module (name TBD in `/plan`, e.g. `adaptive-poll-controller.ts`) MUST own the branch logic and the regression test. Each of the three services MUST delegate through the helper and MUST have a thin per-service test asserting its own divisor/clamp are passed through. | P2 | Q4=C. Regression fence against re-introducing the dead-branch behaviour in any of the three call sites (or a fourth, if one is added). |
| FR-008 | Behaviour on `MergeConflictMonitorService`, whose `recordWebhookEvent()` has no callers in production, MUST be identical to the other two under the new helper — i.e. `webhooksConfigured` is derived at the single decision point and `false` for it in every current configuration, yielding the fixed-fast interval. | P2 | Not required to add a caller for `MergeConflictMonitorService.recordWebhookEvent()` (out of scope; that would introduce a new webhook feeder). |

## Success Criteria

| ID     | Metric                                                                                       | Target                                                                                | Measurement                                                                       |
|--------|----------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| SC-001 | Time from label change to worker enqueue on a smee-less cluster                              | ≤ `basePollIntervalMs / ADAPTIVE_DIVISOR` (currently ~10s at defaults — clamp binds) from cycle 1 | Set label on issue, observe orchestrator log for `phase-tracker` / enqueue.       |
| SC-002 | `intervalMs` in structured logs at construction, for each of `LabelMonitorService`, `PrFeedbackMonitorService`, `MergeConflictMonitorService` on a smee-less cluster | Fixed-fast value present on cycle 1 (no adaptation over time) | `grep 'intervalMs' orchestrator logs` on the `snappoll` cluster reproduction. |
| SC-003 | Zero regressions in smee-enabled path (LabelMonitor)                                         | Existing tests + fresh unit tests around `updateAdaptivePolling` all pass             | Test suite green.                                                                 |
| SC-004 | Dead-branch elimination in **all three** services                                            | The early-return on `lastWebhookEvent === null` no longer produces stuck-at-base behavior for smee-less clusters, in any of the three services | Static: branch removed or guarded by `webhooksConfigured`. Dynamic: SC-001 / SC-002 both green. |
| SC-005 | `adaptivePolling: false` on a smee-less cluster                                              | Service polls at `basePollIntervalMs` indefinitely (operator opt-out honoured)        | Unit test: construct with `adaptivePolling: false`, assert `intervalMs === basePollIntervalMs`. |
| SC-006 | Test values separate the divide from the clamp                                               | For `LabelMonitorService`, at least one test must use `basePollIntervalMs` such that `basePollIntervalMs / 3 !== MIN_POLL_INTERVAL_MS` (e.g. base=60000 → fast=20000) | At defaults (base=30000, divisor=3, min=10000), fast=10000 equals the clamp — a test asserting `intervalMs === 10000` at defaults asserts the clamp, not the divide. |

## Assumptions

- Fix is scoped to construction and `updateAdaptivePolling()` for **three services**:
  `LabelMonitorService`, `PrFeedbackMonitorService`, and `MergeConflictMonitorService`.
  No changes to `SmeeWebhookReceiver`, `PhaseTrackerService`, or worker enqueue. (Q4=C
  extended to all three.)
- A shared helper module owns the branch logic and is called by all three services.
  Divisor and clamp are helper **parameters**, not constants, so per-service constant
  divergence (LabelMonitor=3, PrFeedback=2, MergeConflict=2) is preserved.
- The `webhooksConfigured` signal is derived at the single site that already makes the smee
  decision (`server.ts:487` for LabelMonitor; equivalent construction sites for the other
  two). No new config surface is added.
- The signal lives on `MonitorState` as a new `webhooksConfigured: boolean` field (Q5=A),
  not on `options` only. `webhookHealthy` continues to mean "the configured webhook path
  is currently delivering."
- `MonitorConfig` continues to carry `adaptivePolling`, `pollIntervalMs`, and
  `fallbackPollIntervalMs`; construction-time inputs to each service may gain one
  additional argument (`webhooksConfigured`).
- Fix is orthogonal to #952 (auto-provision a smee channel when none is configured). Both
  changes coexist: #952 reduces how often this path is hit; this fix ensures the fallback
  degrades gracefully when a cluster still ends up on the polling-only path (e.g. smee
  provisioning failed).
- **Scope fallback (if PR review requests a smaller diff):** land the shared helper +
  `LabelMonitorService` migration in this PR; migrate `PrFeedbackMonitorService` and
  `MergeConflictMonitorService` in an immediate follow-up. Do NOT land a LabelMonitor-only
  point fix that leaves the other two copies untouched — that reintroduces the copy-paste
  pathology that produced the bug in the first place.

## Out of Scope

- Auto-provisioning a smee channel — that is #952, and this spec explicitly does not depend on
  it.
- Any change to how webhooks are received or verified.
- Tuning `MIN_POLL_INTERVAL_MS`, `ADAPTIVE_DIVISOR`, or default `basePollIntervalMs` values.
- Normalising divergent constants across the three services (LabelMonitor=3, PrFeedback=2,
  MergeConflict=2). Divergence is documented in-code and must be preserved.
- Adding a webhook feeder for `MergeConflictMonitorService.recordWebhookEvent()` (currently
  callerless). Fixing the dead-branch behaviour is in scope; adding a real webhook path is not.
- Changes to the rate-limit / backoff logic elsewhere in any of the three services.
- Deleting `adaptivePolling` from `MonitorConfig` (spec prefers making it live, per FR-005).

## Related

- #952 — Orchestrator should auto-provision a smee channel when none is configured. Companion,
  not a prerequisite.

---

*Generated by speckit*
