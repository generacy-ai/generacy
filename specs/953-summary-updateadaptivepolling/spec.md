# Feature Specification: Engage adaptive polling for clusters with no configured webhook

**Branch**: `953-summary-updateadaptivepolling` | **Date**: 2026-07-16 | **Status**: Draft
**Issue**: [#953](https://github.com/generacy-ai/generacy/issues/953) — `workflow:speckit-bugfix`

## Summary

`LabelMonitorService.updateAdaptivePolling()` treats "no webhook event has *ever* arrived" as
healthy and returns before the elapsed-time check runs. Because `state.lastWebhookEvent` is only
ever written by `SmeeWebhookReceiver.recordWebhookEvent()`, and no receiver is constructed when
`config.smee.channelUrl` is unset (`packages/orchestrator/src/server.ts:487`), a cluster with no
smee channel keeps `lastWebhookEvent === null` for its entire lifetime. The adaptive-polling
safety net therefore never engages for the exact population it exists to protect: clusters that
have no real-time event path at all.

Confirmed on the `snappoll` cluster — `intervalMs: 30000` at startup, no smee receiver, interval
never adapts.

Two states are being conflated by the current early-return:

- **Smee configured, no events yet** — genuinely ambiguous; the channel may just be quiet.
- **No smee receiver at all** — unambiguous; webhooks are definitively not working and will not
  start without a config change. Knowable at construction time.

Additionally, when smee **is** configured, `server.ts:469-471` sets `adaptivePolling: false` and
uses `config.smee.fallbackPollIntervalMs`. So adaptive polling is only ever *live* in the no-smee
case — i.e., the exact case the early return silently disables. As written, the
`adaptivePolling` flag has no reachable effect at all.

## User Stories

### US1: Cluster operator whose webhooks were never configured (P1)

**As a** cluster operator running a freshly provisioned cluster with no smee channel,
**I want** the orchestrator's label-monitor loop to detect that webhooks are not delivering and
poll GitHub at the faster adaptive interval from the outset,
**So that** issue-label transitions are picked up on the order of seconds instead of the base
30-second interval, and the safety-net behavior that already exists in code actually runs.

**Acceptance Criteria**:
- [ ] A cluster started with no `config.smee.channelUrl` polls at the adaptive interval
      (`basePollIntervalMs / ADAPTIVE_DIVISOR`, clamped to `MIN_POLL_INTERVAL_MS`) rather than
      the base interval.
- [ ] The transition happens without requiring any real webhook event to have arrived.
- [ ] Structured log line confirms the reason (e.g. `webhooksConfigured: false`), distinct from
      the existing "webhooks appear unhealthy" transition.
- [ ] Behavior of clusters that **do** have a configured smee channel is unchanged —
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

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                | Priority | Notes                                                                                                                        |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|------------------------------------------------------------------------------------------------------------------------------|
| FR-001 | `LabelMonitorService` MUST distinguish "webhooks not configured" from "webhooks configured but quiet".                                                                                                                                     | P1       | The signal is knowable at construction time from `config.smee.channelUrl`.                                                   |
| FR-002 | When webhooks are not configured, adaptive polling MUST engage immediately (or via a bounded startup grace) — the service MUST NOT poll indefinitely at `basePollIntervalMs` in this case.                                                 | P1       | Options: skip adaptive-polling entirely and run at the faster interval from the start, OR treat webhooks as unhealthy immediately, OR seed `lastWebhookEvent` at poll-loop start so the existing threshold engages after `basePollIntervalMs * 2`. |
| FR-003 | When webhooks are configured (a `SmeeWebhookReceiver` is constructed), behavior MUST remain unchanged: `adaptivePolling` stays `false`, `fallbackPollIntervalMs` is used, and `recordWebhookEvent()` continues to drive `webhookHealthy`.  | P1       | Preserves the current smee-enabled code path in `server.ts:469-471` verbatim.                                                |
| FR-004 | The service MUST emit a structured log line the first time it engages adaptive polling for the no-webhooks-configured reason, with fields that distinguish it from the existing "webhooks appear unhealthy" transition.                    | P2       | Debuggability — an operator should be able to `grep` logs and tell which branch fired.                                       |
| FR-005 | The `adaptivePolling: boolean` flag on `MonitorConfig` MUST have a reachable effect for at least one code path (currently it has none).                                                                                                    | P2       | Either honor it as an operator opt-out for the no-smee case, or delete it. Preference: honor it (default `true`).            |
| FR-006 | The fix MUST NOT alter `MIN_POLL_INTERVAL_MS` or `ADAPTIVE_DIVISOR` semantics; the same clamp applies whether the trigger is "webhook went silent" or "webhook never configured".                                                          | P2       | Keeps the failure-mode ceiling on API-call rate identical.                                                                   |
| FR-007 | Unit coverage MUST assert both (a) a no-smee construction yields a faster steady-state interval, and (b) a smee-configured construction with an idle webhook does not (until the existing elapsed-time threshold trips).                   | P2       | Regression fence against re-introducing the dead-branch behavior.                                                            |

## Success Criteria

| ID     | Metric                                                                                       | Target                                                                                | Measurement                                                                       |
|--------|----------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| SC-001 | Time from label change to worker enqueue on a smee-less cluster                              | ≤ `basePollIntervalMs / ADAPTIVE_DIVISOR` (currently ~2s at defaults) after ≤ 1 cycle | Set label on issue, observe orchestrator log for `phase-tracker` / enqueue.       |
| SC-002 | `intervalMs` in `LabelMonitorService` structured logs on a smee-less cluster                 | Reaches the adaptive value within one poll cycle of startup                           | `grep 'intervalMs' orchestrator logs` on the `snappoll` cluster reproduction.     |
| SC-003 | Zero regressions in smee-enabled path                                                        | Existing tests + fresh unit tests around `updateAdaptivePolling` all pass             | Test suite green.                                                                 |
| SC-004 | Dead-branch elimination                                                                      | The early-return on `lastWebhookEvent === null` no longer produces the stuck-at-base behavior for smee-less clusters | Static: branch removed or guarded by `webhooksConfigured`. Dynamic: SC-001 / SC-002 both green. |

## Assumptions

- Fix is scoped to `LabelMonitorService` construction and `updateAdaptivePolling()`; no changes
  to `SmeeWebhookReceiver`, `PhaseTrackerService`, or worker enqueue.
- The `webhooksConfigured` signal is derived at the single site that already makes the smee
  decision (`server.ts:487`). No new config surface is added.
- `MonitorConfig` continues to carry `adaptivePolling`, `pollIntervalMs`, and
  `fallbackPollIntervalMs`; construction-time inputs to `LabelMonitorService` may gain one
  additional argument (`webhooksConfigured`).
- Fix is orthogonal to #952 (auto-provision a smee channel when none is configured). Both
  changes coexist: #952 reduces how often this path is hit; this fix ensures the fallback
  degrades gracefully when a cluster still ends up on the polling-only path (e.g. smee
  provisioning failed).

## Out of Scope

- Auto-provisioning a smee channel — that is #952, and this spec explicitly does not depend on
  it.
- Any change to how webhooks are received or verified.
- Tuning `MIN_POLL_INTERVAL_MS`, `ADAPTIVE_DIVISOR`, or default `basePollIntervalMs` values.
- Changes to the label-monitor rate-limit / backoff logic elsewhere in the service.
- Deleting `adaptivePolling` from `MonitorConfig` (spec prefers making it live, per FR-005).

## Related

- #952 — Orchestrator should auto-provision a smee channel when none is configured. Companion,
  not a prerequisite.

---

*Generated by speckit*
