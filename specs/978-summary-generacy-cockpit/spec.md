# Feature Specification: ## Summary

The `generacy cockpit doorbell` surface shipped by #970 / #431 is **poll-fed, not smee-fed**

**Branch**: `978-summary-generacy-cockpit` | **Date**: 2026-07-17 | **Status**: Draft

## Summary

## Summary

The `generacy cockpit doorbell` surface shipped by #970 / #431 is **poll-fed, not smee-fed**. It subscribes to cockpit's in-process event-bus, which is driven by a 30-second GitHub poll loop — so `/cockpit:auto` notification latency is bounded by that poll (~25s observed between a `waiting-for:clarification` label landing and the auto conversation being woken), **even on clusters where smee is live**. The revised FR-011 posted on #970 (doorbell subscribes to the smee stream, poll only as fallback) was never implemented — it landed after implementation was already underway.

This is "Cause 2" of the auto-notification latency. "Cause 1" (the orchestrator's own smee being dead because the repo webhook isn't registered) is tracked in **#972**. **Both** must land for near-instant notification; fixing #972 alone does not speed up the doorbell.

## Evidence

Shipped preview `0.0.0-preview-20260717164640-73fe178`, inspected in a running snappoll cluster:

- `dist/cli/commands/cockpit/doorbell/subscribe.js` — `subscribeAndEmit(bus, …)` loops on `bus.waitFor({ maxWaitMs: 60_000, coalesceWindowMs: 0, maxBatchSize: 100 })`, i.e. it consumes the cockpit **in-process event-bus** (the same bus `cockpit_await_events` drains).
- `dist/cli/commands/cockpit/mcp/event-bus-registry.js` — `DEFAULT_INTERVAL_MS = 30_000`; the bus is fed by `runOnePoll` / `resolveEpic` (GitHub polling via `gh`).
- **Zero** references to `smee` / `EventSource` / `text/event-stream` / `/events` / `channelUrl` anywhere in the shipped cockpit command tree.
- Observed on a smee-provisioned cluster: ~25s from `waiting-for:clarification` applied → auto conversation notified. That is the 30s poll interval, not a real-time signal.

## Why it matters

The whole point of the doorbell (vs. the retired `generacy cockpit watch`) was to remove polling from the notification path. Today it still polls — just from a different process. On a smee-live cluster the raw GitHub webhook stream (`issues` / `pull_request` / `check_run` / `check_suite`) is already arriving in ~1–3s; the doorbell ignores it and re-derives the same transitions by polling GitHub every 30s, which is both slower and additional API cost.

## Proposed fix — implement the revised FR-011

Make `generacy cockpit doorbell <epic-ref>` real-time-first:

1. Discover the cluster's smee channel URL (read the persisted channel file written by `SmeeChannelResolver`, same source the orchestrator's `SmeeWebhookReceiver` uses).
2. Subscribe to it as an independent SSE consumer (model the client on `packages/orchestrator/src/services/smee-receiver.ts`), filter payloads to the epic's repo/refs, and emit one doorbell stdout line per relevant transition. The line remains a **doorbell only** — typed data still flows through `cockpit_await_events`.
3. **Fallback:** when no smee channel is configured/reachable, fall back to the existing 30s event-bus poll loop — the same real-time-first / poll-as-safety-net pattern the orchestrator uses (`packages/orchestrator/src/server.ts:470-473`). Do **not** remove the poll loop: smee.io is a free best-effort relay (no delivery guarantee), so the poll fallback stays as the safety net.
4. Best-effort smee gaps (disconnects) are already covered by the auto skill's `ScheduleWakeup` heartbeat — a doorbell only needs to wake, not to be lossless.

## Dependencies / relationships

- **Depends on #972** — the doorbell can only ride smee once the repo webhook is actually registered (the `admin:repo_hook` grant). Until then the smee channel is empty and the doorbell correctly falls back to polling.
- **Parent: #970** — shipped the poll-cost reductions + the poll-loop-backed doorbell (original FR-011). This issue implements the revised FR-011 that was commented on #970 but not built.
- **agency#431** — no skill-side change required; it already spawns `generacy cockpit doorbell` under Monitor and stays passive. Only the engine-side doorbell implementation changes.

## Acceptance

- [ ] On a smee-live cluster, latency from a label transition to the doorbell emitting its line is ≤ ~3s p95 (vs. ~25s today).
- [ ] On a cluster with no reachable smee channel, the doorbell falls back to the poll loop with no behavior change.
- [ ] No regression to #970's poll-cost reductions (the fallback path keeps them).
- [ ] The FR-006 capability probe in agency#431 still gates correctly.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
