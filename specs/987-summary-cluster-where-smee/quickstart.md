# Quickstart: Verifying the monitor webhook flip

**Feature**: `987-summary-cluster-where-smee`
**Date**: 2026-07-18

This quickstart covers verifying that #987's fix landed correctly on an auto-provisioned smee-channel cluster (the target of the bug).

## Prerequisites

- A running Generacy cluster provisioned via `generacy launch` (no static `SMEE_CHANNEL_URL`), or an existing cluster where `.generacy/smee-channel.txt` was written by `SmeeChannelResolver` (the #952 persisted path).
- The cluster has resolved a smee URL and the smee receiver is running. Confirm via:
  ```bash
  docker compose logs orchestrator | grep 'Connected to smee.io channel'
  ```
- The four repositories under `orchestrator.repositories` are configured and have at least one open assigned issue for meaningful log traffic.

## Golden path (SC-001, SC-002)

After the orchestrator boots and the smee receiver connects:

1. Tail the orchestrator log for one of the four monitor names and confirm `webhooksConfigured=true`:
   ```bash
   docker compose logs -f orchestrator | grep -E '(LabelMonitor|PrFeedbackMonitor|MergeConflictMonitor|ClarificationAnswerMonitor)'
   ```
   Expect: each monitor's next `updateAdaptivePolling`-emitted log carries `reason=quiet` and `currentPollIntervalMs` equal to `config.smee.fallbackPollIntervalMs` (default 600000 ms).

2. Grep for the absence of the bug's fingerprint over a 5-minute window:
   ```bash
   docker compose logs --since 5m orchestrator | grep -c 'reason=webhooks-not-configured'
   ```
   Expect: `0`.

3. Grep for the `Connected` → flip edge:
   ```bash
   docker compose logs orchestrator | grep -A5 'Connected to smee.io channel'
   ```
   Expect: within a few log lines, four monitor-scoped info messages roughly of the form `interval=... reason=quiet` or state updates that show `currentPollIntervalMs` transitioning to the fallback cadence.

## Adaptive escalation (US2, FR-005)

Simulate a smee-receiver outage without restarting the orchestrator:

1. Confirm the receiver is running: `docker compose logs -f orchestrator | grep smee` should show ongoing SSE activity.
2. Force an outage (choose one):
   - Block outbound traffic to `smee.io` via a firewall rule on the cluster host: `sudo ufw deny out to smee.io` (revert after).
   - Kill the smee receiver via a debug-only endpoint (if #987 adds one — not required).
3. Wait `basePollIntervalMs * 2` (default: 20 minutes with the 600s fallback). Look for a `reason=webhook-stale` log line from each of the four monitors.
   Expect: `currentPollIntervalMs` drops to the fast interval (`min(basePoll / adaptiveDivisor, 10_000)`). For LabelMonitor (`ADAPTIVE_DIVISOR=3`): fast interval ≈ 10s. For PR-feedback / merge-conflict / clarification-answer (`ADAPTIVE_DIVISOR=2`): fast interval ≈ 10s (clamped by the 10s min-interval floor).
4. Restore smee connectivity. Wait for the next real GitHub delivery.
   Expect: `reason=webhook-recovered`, `transition=to-base`, `currentPollIntervalMs` returns to the fallback cadence.

## Verifying FR-004 wiring

Trigger a real event of each family:

- **Label event**: `gh issue edit <n> --add-label 'process:speckit-feature' --repo <owner>/<repo>` (assumes label exists and issue is assigned to the cluster). Expect `LabelMonitorService` to enqueue via the smee path (`source: 'webhook'`, not `source: 'poll'`).
- **PR review**: submit a review on a PR linked to an orchestrated issue. Expect `PrFeedbackMonitorService.processPrReviewEvent` to run via the smee path.
- **Issue comment**: post a human comment on an issue that has `waiting-for:clarification + agent:paused`. Expect `ClarificationAnswerMonitorService.processClarificationAnswerEvent` to run via the smee path (and enqueue a `continue` resume).
- **Any watched-repo event**: fire an arbitrary `pull_request` webhook. Expect the four monitors' `state.lastWebhookEvent` to advance (verifiable via a hypothetical `/health/monitor-state` debug route, or by inspecting adaptive-poll logs after the event lands).

## GraphQL rate-limit sanity check (SC-003)

On an idle cluster (no work in flight), sample the GitHub App-installation-token rate-limit headers over 5 minutes:

```bash
docker compose logs orchestrator | \
  grep -oE 'x-ratelimit-remaining: [0-9]+' | \
  head -20
```

Expect: the remaining-count drops by no more than a bounded amount per minute — roughly `4 monitors ÷ fallbackPollIntervalMs`. Pre-fix, the drop rate was `4 ÷ 10s` (fast cadence).

## Log verification cheatsheet

| Assertion | grep string | Expected |
|---|---|---|
| SC-001 | `currentPollIntervalMs` on any monitor log | `== fallbackPollIntervalMs` |
| SC-002 | `reason=webhooks-not-configured` | 0 occurrences post-connect |
| SC-004 (labels) | `Smee webhook received label event` | fires on `gh issue edit` |
| SC-004 (PR reviews) | `Processing PR review event from webhook` | fires on real review |
| SC-004 (clarification) | `Processing clarification-answer event` (webhook variant) | fires on human comment |

## Rolling back

The setter is one-way and idempotent; the only fully "off" state is the pre-fix behavior. To roll back manually, revert `packages/orchestrator/` changes for #987 (`.changeset/987-monitors-webhook-flip-on-connect.md`, `server.ts`, `services/*monitor-service.ts`, `services/smee-receiver.ts`). No data migration is required.

## Troubleshooting

- **Monitors stay at the fast interval after `Connected to smee.io channel`**: `onConnected` callback did not fire. Check that `startSmeePipeline` in `server.ts` passes `onConnected` in `SmeeReceiverOptions` and that all four monitor refs are captured in the closure. Compare against `contracts/smee-receiver-contract.md`.
- **`webhook-stale` never fires after receiver death**: check `state.lastWebhookEvent` — if it's `null`, the `recordWebhookEvent` fan-out isn't reaching the monitor. Verify `SmeeWebhookReceiver` was constructed with all four monitor refs. Check the receiver's SSE processing path — the fan-out fires before the processing dispatch's `try/catch`.
- **`ClarificationAnswerMonitorService` never enters `webhook-stale`**: verify the constructor rewrite delegates to `decideAdaptivePoll` (research.md §Question 6). The inline logic that existed pre-fix cannot reach `webhook-stale`.
