# Feature Specification: orchestrator monitors stuck in poll mode on auto-provisioned smee channel

**Branch**: `987-summary-cluster-where-smee` | **Date**: 2026-07-18 | **Status**: Draft

## Summary

On a cluster where the smee channel is **auto-provisioned at runtime** (no static `SMEE_CHANNEL_URL` — the #952 path), the orchestrator registers the webhook, connects the smee receiver, and GitHub delivers events (verified HTTP 200) — yet the label / PR-feedback / merge-conflict / clarification monitors keep ingesting via **poll** at the fast adaptive cadence, logging `Webhooks appear unhealthy … reason=webhooks-not-configured`. This burns GitHub App-installation-token GraphQL continuously and defeats the event-driven design (the whole point of the smee channel is to remove polling).

Observed on the snappoll preview cluster (2026-07-18): webhook id 653871794 active and delivering `issues`/`pull_request` events HTTP 200, `Connected to smee.io channel`, but every ingested event shows `source:poll` and the monitors sit at the 10s fast interval.

## Root cause

`webhooksConfigured` and the poll-mode decision are frozen at monitor **construction time** from the **static** `config.smee.channelUrl`, which is `null` on the auto-provisioned path:

- [`server.ts:478-480`](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/server.ts#L478-L480): `monitorConfig = config.smee.channelUrl ? {adaptivePolling:false, pollIntervalMs: fallback} : config.monitor` — static URL is null → `adaptivePolling:true`.
- [`server.ts:493`](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/server.ts#L493): `config.smee.channelUrl != null` is passed as the `webhooksConfigured` constructor arg → `false`.
- The runtime channel is resolved later, at `onReady` ([`server.ts:571-586`](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/server.ts#L571-L586)), and `startSmeePipeline(result.channelUrl)` starts the receiver + webhook setup — but it **never updates the already-constructed monitors'** `webhooksConfigured` flag or poll cadence.
- [`adaptive-poll-controller.ts:105-122`](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/services/adaptive-poll-controller.ts#L105-L122): with `webhooksConfigured=false, adaptivePolling=true` the controller returns `reason:'webhooks-not-configured'` at the fast interval — **permanently**, regardless of webhook events actually being received.
- `clarification-answer-monitor-service.ts:135` hardcodes `webhooksConfigured: false` — same family.

So `startSmeePipeline` runs for static, persisted, AND provisioned channels, but only the **static** path also flips the construction-time gate (lines 478-480 / 493). The provisioned and persisted paths leave every monitor believing webhooks aren't configured. This is a #952 (runtime provisioning) ↔ #953 (adaptive poll controller) integration miss.

## Proposed fix

`startSmeePipeline(channelUrl)` should flip the monitors into "webhooks live" mode at runtime for **all** channel sources (static, persisted, provisioned): set `webhooksConfigured=true` and switch to the smee **fallback (non-adaptive)** cadence (safety-net polling only). Add a runtime setter to each monitor service — `LabelMonitorService`, `PrFeedbackMonitorService`, `MergeConflictMonitorService`, `ClarificationAnswerMonitorService` — e.g. `setWebhooksConfigured(true)` that also resets the current poll interval to `config.smee.fallbackPollIntervalMs` and disables adaptive ratcheting, and call it from `startSmeePipeline`.

(Alternative: defer monitor construction until after channel resolution. Rejected as the default — monitors start before `onReady` and existing tests rely on the synchronous static path, so a runtime setter is the more surgical change.)

## Acceptance criteria

- On the auto-provisioned / persisted-channel path, once `startSmeePipeline` runs, all four monitors report `webhooksConfigured=true` and poll at the smee **fallback** cadence (safety-net only), not the fast adaptive interval.
- `Webhooks appear unhealthy` / `reason=webhooks-not-configured` no longer fires once a channel has been resolved and the receiver started.
- Received webhook events update `lastWebhookEvent` and keep the monitors on the base/fallback cadence; adaptive fast-poll fires only on genuine staleness (`webhook-stale`).
- The clarification-answer monitor's hardcoded `webhooksConfigured: false` is covered.
- Changeset included.

## Impact / context

This is the **App-installation-token** half of the cockpit-auto rate-limit story; #985 (engine content-ful line) + #437 (skill enriched dispatch) fixed the **operator-PAT** half. Companion issue generacy-ai/generacy#988 makes the operator doorbell reuse the same channel. Together they make cockpit-auto genuinely webhook-fed end to end. Prereq #972 (webhook registration) is now working. Related: #952, #953.

## User Stories

### US1: cockpit-auto sessions on auto-provisioned clusters run event-driven, not poll-driven

**As a** developer running `/cockpit:auto` on a preview cluster with an auto-provisioned smee channel (the #952 zero-config path),
**I want** the label / PR-feedback / merge-conflict / clarification monitors to recognize that webhooks are live once `startSmeePipeline` runs,
**So that** the session ingests events via smee at the low-cost fallback cadence instead of hammering GitHub with 10s fast-adaptive polls that exhaust the App-installation-token GraphQL quota within an hour.

**Acceptance Criteria**:
- [ ] After the async smee-channel resolver fires `startSmeePipeline(...)`, all four monitors report `webhooksConfigured=true`.
- [ ] All four monitors run at `config.smee.fallbackPollIntervalMs` (safety-net cadence), not at the adaptive fast interval.
- [ ] Neither `Webhooks appear unhealthy` nor `reason=webhooks-not-configured` fires after the pipeline is up.
- [ ] Received webhook events call `recordWebhookEvent()` on the target monitor; adaptive fast-poll only fires on genuine `webhook-stale` (no event for `basePoll * 2` after one has been recorded).
- [ ] The synchronous static-URL path (`config.smee.channelUrl` set at boot) is unchanged — the runtime setter is a no-op when it's already in the target state.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `LabelMonitorService`, `PrFeedbackMonitorService`, `MergeConflictMonitorService`, and `ClarificationAnswerMonitorService` each expose a runtime setter `setWebhooksConfigured(configured: boolean, opts?: { basePollIntervalMs?: number })`. When called with `true`, it must (a) set `state.webhooksConfigured = true`, (b) set `state.basePollIntervalMs` and `state.currentPollIntervalMs` to `opts.basePollIntervalMs` when provided (else leave unchanged), and (c) set `options.adaptivePolling = false`. | P1 | Mirrors the static-path gate at `server.ts:478-480` + `:493` but applies at runtime after construction. |
| FR-002 | `startSmeePipeline(channelUrl)` in `server.ts` calls `setWebhooksConfigured(true, { basePollIntervalMs: config.smee.fallbackPollIntervalMs })` on every constructed monitor (label, PR-feedback, merge-conflict, clarification-answer). This runs for **all** channel sources: static-URL (idempotent no-op), persisted-file, and provisioned-runtime. | P1 | Single call site — the existing pipeline entry point. |
| FR-003 | `ClarificationAnswerMonitorService`'s hardcoded `webhooksConfigured: false` (`clarification-answer-monitor-service.ts:135`) is removed in favor of a constructor arg + the FR-001 setter, matching the other three services. | P1 | Prevents the same regression when the service is later moved to the constructor-arg pattern of the other three. |
| FR-004 | `SmeeWebhookReceiver` (or the equivalent inbound webhook handler for each event kind) calls `recordWebhookEvent()` on the corresponding monitor when a webhook is dispatched to it. `LabelMonitorService.recordWebhookEvent()` and the sibling methods stay unchanged. | P1 | Prior state: only `LabelMonitorService` was reachable from `SmeeWebhookReceiver`. Verify PR-feedback / merge-conflict / clarification-answer receive their events too. |
| FR-005 | After `setWebhooksConfigured(true, ...)` runs, `decideAdaptivePoll` for that monitor must return `reason: 'quiet'` (or `'webhook-stale'` on genuine staleness, or `'webhook-recovered'` on recovery). It must never return `'webhooks-not-configured'` or `'operator-opt-out'` again for the lifetime of that monitor. | P1 | Follows from the branch matrix in `adaptive-poll-controller.ts:90-166`. |
| FR-006 | New/updated unit tests assert: (a) each monitor's `setWebhooksConfigured(true, { basePollIntervalMs: N })` mutates state + options as specified in FR-001; (b) after the flip, `decideAdaptivePoll` returns `reason: 'quiet'` with `webhookHealthy: true` on the first cycle post-flip; (c) `server.ts`'s `startSmeePipeline` calls the setter on all four constructed monitors; (d) the static-URL boot path is unchanged (`monitorConfig` still built with `adaptivePolling:false`, and the runtime setter is a no-op). | P1 | Regression coverage for the four-monitor fan-out. |
| FR-007 | Changeset entry added under `packages/orchestrator` (`patch` — bug fix, `workflow:speckit-bugfix`, no new public capability). | P1 | CI gate per project CLAUDE.md. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `reason=webhooks-not-configured` log lines emitted by any of the four monitors on an auto-provisioned cluster after `startSmeePipeline` completes. | 0 | Grep orchestrator logs on the snappoll preview cluster (or equivalent) for `reason=webhooks-not-configured` after the "Resolved smee channel URL — starting pipeline" line. |
| SC-002 | Effective poll cadence for each of the four monitors on the auto-provisioned path, measured after `startSmeePipeline`. | `config.smee.fallbackPollIntervalMs` (per `server.ts:478-479` — today's static-URL cadence). | Instrument or read `currentPollIntervalMs` via a debug endpoint / log line; assert equals `fallbackPollIntervalMs` on both the static and provisioned paths. |
| SC-003 | GitHub App-installation-token GraphQL points consumed per hour by an idle cluster with the auto-provisioned smee channel, no active work. | Comparable to a cluster with a static `SMEE_CHANNEL_URL` — an order of magnitude below the pre-fix baseline (which exhausted 5000 pts/hr). | `gh api rate_limit` delta over one idle hour, provisioned-path cluster, compared to a static-URL cluster and to the pre-fix baseline. |
| SC-004 | Regression on the static-URL boot path: existing `LabelMonitorService` + `MergeConflictMonitorService` + `PrFeedbackMonitorService` tests + `server.ts` boot tests. | 0 | All existing tests pass without changes to their assertions. |

## Assumptions

- The fix mutates in-flight monitors via a runtime setter rather than deferring monitor construction until channel resolution completes. Rationale: monitors start synchronously before `onReady`, existing tests rely on the synchronous static-URL path, and the async channel-resolver already fires from within `onReady` — the setter is the narrower change.
- `config.smee.fallbackPollIntervalMs` is the correct cadence for **all** channel sources once the pipeline is live (static, persisted, provisioned). Static-URL boot already uses this exact value at `server.ts:478-479`; the fix generalizes it to the other two channel sources.
- Setting `options.adaptivePolling = false` in the setter is safe: after the flip, the adaptive-fast interval is no longer reachable via `webhooks-not-configured`, and staleness is a distinct condition that still triggers `webhook-stale → to-fast` on genuine event drought.
- `SmeeWebhookReceiver` currently only calls `recordWebhookEvent()` on the label monitor. If FR-004 verification finds that PR-feedback / merge-conflict / clarification-answer inbound webhooks don't reach their monitor's `recordWebhookEvent`, this spec expands to include that wiring. Otherwise it stays out of scope.
- The clarification-answer monitor's `webhooksConfigured: false` at line 135 is the same construction-time freeze in a slightly different clothes; FR-003 aligns it structurally so future refactors can't reintroduce the divergence.
- The paired half of the cockpit-auto rate-limit story (operator-PAT doorbell, #985 + agency#437) is a separate change. This spec fixes only the App-installation-token half — the four in-orchestrator monitors.

## Out of Scope

- Deferring monitor construction until after channel resolution (rejected — the runtime-setter approach is more surgical and preserves existing tests).
- Wiring the doorbell/operator-PAT path to reuse the same channel — that's the companion issue #988.
- The generacy engine content-ful doorbell line + skill dispatch changes (#985 + agency#437 — separate PRs, already landed / in progress).
- Adding new webhook event types beyond `issues` / `pull_request` / whatever the current receiver dispatches — the fix is about the poll-mode state gate, not event coverage.
- Rate-limit-error retry classification (#982 defense-in-depth — already merged).
- Reworking `adaptive-poll-controller.ts`'s branch matrix — the controller is correct; the bug is upstream in the state fed to it.

---

*Generated by speckit*
