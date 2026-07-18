# Research: Monitors stuck at `webhooks-not-configured` on auto-provisioned smee path

**Feature**: `987-summary-cluster-where-smee`
**Date**: 2026-07-18

## Question 1 — Why does the bug only surface on the auto-provisioned / persisted-channel paths?

`server.ts:478-480` sets `monitorConfig` and `server.ts:493` passes `config.smee.channelUrl != null` as the `webhooksConfigured` constructor arg. On the **static** path (`SMEE_CHANNEL_URL` env), `config.smee.channelUrl` is populated before construction, so:

- `monitorConfig` has `adaptivePolling: false, pollIntervalMs: fallbackPollIntervalMs`.
- `webhooksConfigured` constructor arg is `true`.
- The controller enters the `webhooksConfigured === true` branch at construction time; `webhooks-not-configured` is unreachable.

On the **auto-provisioned** / **persisted-channel** path (#952), `config.smee.channelUrl` is `null` at construction:

- `monitorConfig` is `config.monitor` (adaptivePolling: true, pollIntervalMs: 30s).
- `webhooksConfigured` constructor arg is `false`.
- `SmeeChannelResolver` runs asynchronously inside `onReady` and eventually calls `startSmeePipeline(result.channelUrl)`, which starts the receiver and (optionally) `WebhookSetupService`.
- **But** `startSmeePipeline` never touches the already-constructed monitors' state. The `webhooksConfigured=false + adaptivePolling=true` combo is baked in; `adaptive-poll-controller.ts:105-122` returns `{ reason: 'webhooks-not-configured' }` at the fast interval permanently.

**Decision**: the fix is at the runtime handoff point — `startSmeePipeline` must inform the four monitors that the smee leg is live. A runtime setter is the surgical shape.

**Alternative considered**: defer monitor construction until after `onReady` resolves the channel URL. **Rejected** — the static path relies on synchronous construction (existing tests, `smeeReceiver` non-null before `onReady` runs, `startSmeePipeline(config.smee.channelUrl)` invoked at construction time). The runtime setter avoids reshaping the boot sequence.

## Question 2 — What is the correct point inside `startSmeePipeline` to flip `webhooksConfigured=true`?

Options:
- **A** (top of function): flag flips before receiver connect. If the receiver fails to connect, monitors sit at fallback cadence with no events landing — safety net disabled during outage.
- **B** (after receiver `Connected`): flag flips on observable evidence the smee leg is live. Webhook registration is not gated.
- **C** (after both receiver connect + webhook registration succeeds): most conservative; extends fast-poll window until both are healthy.
- **D** (after receiver, revert on webhook registration failure): requires bidirectional setter (Q1=A precludes this).

**Decision (Q5=B)**: flip on receiver-connect. On the auto-provisioned / persisted paths, webhook registration is usually an idempotent no-op (`Webhook already exists and is active`); C would add latency for no functional gain. A lagging or failed registration is surfaced by the #972 fail-loud triple; staying in pre-flip fast-poll during that window is the correct conservative behaviour.

**Implementation shape**: `SmeeWebhookReceiver` gains an optional `onConnected: () => void` callback in `SmeeReceiverOptions`. Fired exactly once, immediately after the existing `'Connected to smee.io channel'` log line at `smee-receiver.ts:143`. Subsequent reconnects (`this.reconnectAttempt` resets to 0) do NOT re-fire.

## Question 3 — Why not set `options.adaptivePolling = false` in the setter?

The controller's decision matrix:

- `webhooksConfigured=false, adaptivePolling=true`: fast interval, `webhooks-not-configured`.
- `webhooksConfigured=false, adaptivePolling=false`: base interval, `operator-opt-out`.
- `webhooksConfigured=true`: staleness + recovery branches govern, regardless of `adaptivePolling`.

Setting `adaptivePolling=false` in the setter would still work for the flag flip **during** the healthy phase — but if the smee receiver later dies (network drop, channel closed, receiver crashes), the staleness path (`webhook-stale → to-fast`) does NOT depend on `adaptivePolling` (it's inside the `webhooksConfigured=true` branch at `adaptive-poll-controller.ts:151-157`). So Q1=A's rationale is: leaving `adaptivePolling` alone costs nothing (it's not read in this branch) and preserves the invariant that the setter is "one field flip + one interval adjust" — no state-machine coupling.

**Decision (Q2=A)**: setter leaves `options.adaptivePolling` unchanged. The two things it touches are `state.webhooksConfigured` and `state.basePollIntervalMs` + `state.currentPollIntervalMs`.

**Subtle point** (Key Decision #9 in plan.md): the setter must also update `state.basePollIntervalMs`, not just `state.currentPollIntervalMs`. Reason: the recovery branch at `adaptive-poll-controller.ts:142-149` resets `currentPollIntervalMs` to `basePollIntervalMs`. If `basePollIntervalMs` still holds the construction-time value (`config.monitor.pollIntervalMs`, ~30s), a recovery from staleness would drop the monitor to 30s cadence — not the intended smee `fallbackPollIntervalMs` (~10 min). Both fields must be set together.

## Question 4 — Where does the actual inbound webhook wiring go?

The spec is emphatic (Q3=A) that FR-004 is in scope: any monitor whose inbound path doesn't currently call `recordWebhookEvent()` is wired in this PR. Verification via `grep 'recordWebhookEvent'`:

| Monitor | Direct-HTTP call site | Smee call site |
|---|---|---|
| `LabelMonitorService` | `routes/webhooks.ts:125,144` | `services/smee-receiver.ts:262,291` |
| `PrFeedbackMonitorService` | `routes/pr-webhooks.ts:119` | **none** |
| `MergeConflictMonitorService` | **none** | **none** |
| `ClarificationAnswerMonitorService` | **none** | **none** |

The direct-HTTP paths only wire label + PR-review, so on **any** cluster (smee-configured or not), merge-conflict + clarification-answer monitors' `recordWebhookEvent()` is unreachable. On the smee path (the primary target of #987), PR-feedback is also unreachable.

**Decision**: the smee path is the fix's target. Wire the smee receiver to call `recordWebhookEvent()` on **all four** monitors for every parsed inbound event whose repo matches `watchedRepos`, regardless of `x-github-event` type. Rationale:

- The staleness safety net only needs `lastWebhookEvent` to be non-null and monotonically fresher-than-`basePoll * 2`. It does NOT need per-monitor event dispatching.
- Per-monitor gating (`recordWebhookEvent()` only on the "right" event type per monitor) would leave the merge-conflict monitor without a natural event family, because GitHub doesn't publish a "merge-conflict detected" event. The pause label combo (`waiting-for:merge-conflicts + agent:paused`) is applied by the phase loop after a poll-detected conflict; there's no upstream inbound event to hook.
- Broad fan-out costs one method call per inbound event. Cheap.

**Direct-HTTP paths are not extended** in this PR. FR-004 is satisfied for the smee-primary path (which is the bug in scope). Extending `webhooks.ts` / `pr-webhooks.ts` to broadcast to all four is a follow-up that mirrors this fix on the direct-HTTP side, adjacent to #988.

## Question 5 — Should per-event processing dispatch be added to the smee receiver?

Currently `SmeeWebhookReceiver` only processes `x-github-event === 'issues' && payload.action === 'labeled'`. All other events (which smee delivers as SSE payloads) are read and discarded.

**Decision**: yes, add per-event processing dispatch where the monitor exposes a natural entry point:

- `pull_request_review.submitted` and `pull_request_review_comment.created` → build `PrReviewEvent` and call `PrFeedbackMonitorService.processPrReviewEvent(event)`. Mirrors `routes/pr-webhooks.ts:108-116` payload shape.
- `issue_comment.created` → build `ClarificationAnswerEvent` and call `ClarificationAnswerMonitorService.processClarificationAnswerEvent(event)`. Uses issue labels from the payload (`payload.issue.labels`); assignee filter mirrors the existing smee label-event path.
- Merge-conflict processing: **not wired**. There is no natural GitHub webhook event that indicates a merge conflict has appeared. The poll path (which detects `waiting-for:merge-conflicts + agent:paused`) is authoritative. `recordWebhookEvent()` still fires (per Q4 above) so the staleness safety net is reachable.

**Alternative considered**: only add `recordWebhookEvent()` fan-out; do NOT add per-event processing dispatch. **Rejected** — the smee path exists to eliminate polling latency. Once a PR review or clarification comment arrives via smee, forcing the poll to catch it defeats the point. Adding the two processing dispatches is a natural extension of the fix (and matches the direct-HTTP wiring that already exists for label + PR-review).

## Question 6 — Why rewrite `ClarificationAnswerMonitorService.recordWebhookEvent()` / `updateAdaptivePolling()` to use `decideAdaptivePoll`?

Current implementation at `clarification-answer-monitor-service.ts:404-432` uses inline logic:

- `recordWebhookEvent()` sets `webhookHealthy=true` and, if previously unhealthy, resets `currentPollIntervalMs` to `basePollIntervalMs` — but does not emit `'webhook-recovered'` reason and doesn't handle the case where the monitor was already healthy.
- `updateAdaptivePolling()` bails out on `lastWebhookEvent === null` (never sets fast interval on smee-less clusters, which is why the field is silently `webhooksConfigured: false` today).

Post-fix invariants required by FR-005:

- `reason: 'webhook-stale'` must be emitted on genuine staleness after the flip.
- `reason: 'webhook-recovered'` must be emitted on recovery.
- `reason: 'quiet'` must be emitted on steady-state.
- `reason: 'webhooks-not-configured'` must NEVER fire after `startSmeePipeline` flips the flag.

The inline logic can't satisfy this contract — it doesn't emit any of the `reason` strings. Delegating to `decideAdaptivePoll` (as the other three services already do at `label-monitor-service.ts:577`, `pr-feedback-monitor-service.ts:745`, `merge-conflict-monitor-service.ts:338`) brings the clarification monitor into the same state machine and makes FR-005 hold by construction.

**Decision**: rewrite `ClarificationAnswerMonitorService.recordWebhookEvent()` and `updateAdaptivePolling()` to match the pattern in `label-monitor-service.ts:574-621`. This is not a change to the controller matrix (which is out of scope per plan.md §"Out of Scope"); it's a call-site alignment.

## Key references

- Spec: `specs/987-summary-cluster-where-smee/spec.md`
- Clarifications: `specs/987-summary-cluster-where-smee/clarifications.md`
- Controller: `packages/orchestrator/src/services/adaptive-poll-controller.ts` (#953)
- Smee receiver: `packages/orchestrator/src/services/smee-receiver.ts`
- Channel resolver: `packages/orchestrator/src/services/smee-channel-resolver.ts` (#952)
- Server wiring: `packages/orchestrator/src/server.ts` (lines 466-660)
- Existing monitor shapes:
  - `packages/orchestrator/src/services/label-monitor-service.ts:88-124`
  - `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:74-109`
  - `packages/orchestrator/src/services/merge-conflict-monitor-service.ts:75-108`
  - `packages/orchestrator/src/services/clarification-answer-monitor-service.ts:102-137`
- Sibling monitor state: `packages/orchestrator/src/types/monitor.ts:187-211`
- Direct-HTTP webhook wiring: `packages/orchestrator/src/routes/webhooks.ts`, `packages/orchestrator/src/routes/pr-webhooks.ts`
- Related issues: #952 (channel provisioning), #953 (adaptive-poll controller), #972 (webhook registration), #985 (companion doorbell fix), #988 (companion operator-doorbell reuse)
