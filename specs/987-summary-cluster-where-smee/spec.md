# Feature Specification: ## Summary

On a cluster where the smee channel is **auto-provisioned at runtime** (no static `SMEE_CHANNEL_URL` — the #952 path), the orchestrator registers the webhook, connects the smee receiver, and GitHub delivers events (verified HTTP 200) — yet the label / PR-feedback / merge-conflict / clarification monitors keep ingesting via **poll** at the fast adaptive cadence, logging `Webhooks appear unhealthy … reason=webhooks-not-configured`

**Branch**: `987-summary-cluster-where-smee` | **Date**: 2026-07-18 | **Status**: Draft

## Summary

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

`startSmeePipeline(channelUrl)` flips the monitors into "webhooks live" mode at runtime for **all** channel sources (static, persisted, provisioned). Add a one-way runtime setter — `setWebhooksConfigured(true, opts?)` — to each monitor service (`LabelMonitorService`, `PrFeedbackMonitorService`, `MergeConflictMonitorService`, `ClarificationAnswerMonitorService`) that:

- (i) sets `state.webhooksConfigured = true`;
- (ii) sets the current poll interval to the smee fallback/base cadence (`opts.basePollIntervalMs`, defaulting to `config.smee.fallbackPollIntervalMs`);
- (iii) **leaves `options.adaptivePolling` alone**. The controller only consults `adaptivePolling` in the `!webhooksConfigured` branch ([`adaptive-poll-controller.ts:106`](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/services/adaptive-poll-controller.ts#L106)); once `webhooksConfigured=true` the staleness/recovery branches govern regardless. Preserving `adaptivePolling=true` keeps the `webhook-stale → to-fast` / `webhook-recovered → to-base` safety net reachable, so smee-receiver death is caught by staleness escalation — no `false` case in the setter is needed (see Q1/Q2 clarifications).

Call the setter from `startSmeePipeline` **once the smee receiver reports `Connected`** (not at function top, and not gated on webhook-registration success). This ties the flip to observable evidence the smee leg is live without disabling the fast-poll safety net during the pre-connect window. A lagging/failed webhook registration is surfaced by the #972 fail-loud path; staying in pre-flip fast-poll during that window is the correct conservative behaviour.

The `ClarificationAnswerMonitorService` hardcoded `webhooksConfigured: false` at `clarification-answer-monitor-service.ts:135` is replaced with an **optional constructor parameter** `webhooksConfigured?: boolean = false` (matching the other three services' existing shape, e.g. `label-monitor-service.ts:99`). The `server.ts` construction site is updated to pass `config.smee.channelUrl != null` explicitly, mirroring the `server.ts:493` pattern for the other three.

Inbound webhook wiring for **all four** monitors' `recordWebhookEvent()` is verified as part of this fix; any gap is wired in this same PR. Without a `recordWebhookEvent()` call from the inbound path, the Q2 staleness safety net cannot escalate (it depends on `lastWebhookEvent` being set at least once, otherwise the monitor sits in the `lastWebhookEvent===null` quiet-grace forever). A monitor without inbound-webhook wiring is `webhooksConfigured` in name only.

(Alternative: defer monitor construction until after channel resolution. Rejected as the default — monitors start before `onReady` and existing tests rely on the synchronous static path, so a runtime setter is the more surgical change.)

## Acceptance criteria

- On the auto-provisioned / persisted-channel path, once the smee receiver reports `Connected` inside `startSmeePipeline`, all four monitors report `webhooksConfigured=true` and their **current** poll interval is the smee fallback/base cadence, not the fast adaptive interval.
- `Webhooks appear unhealthy` / `reason=webhooks-not-configured` no longer fires for any of the four monitors once a channel has been resolved and the receiver started.
- Received webhook events reach `recordWebhookEvent()` on the corresponding monitor, update `lastWebhookEvent`, and keep the monitor on the base cadence. Adaptive fast-poll (`reason: 'webhook-stale'`) still fires on genuine staleness, and `reason: 'webhook-recovered'` still fires on recovery — the safety net is preserved.
- The `ClarificationAnswerMonitorService` hardcoded `webhooksConfigured: false` is replaced with an optional constructor parameter (default `false`), passed explicitly from `server.ts` as `config.smee.channelUrl != null`.
- Setter is one-way (`setWebhooksConfigured(true, …)` only); no `false` case in the API surface.
- Inbound-webhook wiring for PR-feedback, merge-conflict, and clarification-answer monitors is verified in code, and any missing `recordWebhookEvent()` call from the inbound dispatcher is added.
- Changeset included.

## Impact / context

This is the **App-installation-token** half of the cockpit-auto rate-limit story; #985 (engine content-ful line) + #437 (skill enriched dispatch) fixed the **operator-PAT** half. Companion issue generacy-ai/generacy#988 makes the operator doorbell reuse the same channel. Together they make cockpit-auto genuinely webhook-fed end to end. Prereq #972 (webhook registration) is now working. Related: #952, #953.


## User Stories

### US1: Operator running an auto-provisioned cluster

**As a** cluster operator on a cluster where the smee channel is auto-provisioned at runtime (no static `SMEE_CHANNEL_URL`),
**I want** the label / PR-feedback / merge-conflict / clarification-answer monitors to consume events from the webhook path once the smee receiver is Connected,
**So that** the cluster stops burning GitHub App-installation-token GraphQL on fast adaptive polling and behaves like the event-driven design intends.

**Acceptance Criteria**:
- [ ] After `startSmeePipeline` sees the smee receiver connect, all four monitors show `webhooksConfigured=true` in logs and their `currentPollIntervalMs` equals the smee fallback cadence.
- [ ] No monitor emits `reason=webhooks-not-configured` after the receiver connects.
- [ ] A real GitHub delivery reaches `recordWebhookEvent()` on the monitor for the relevant event family.

### US2: Smee-receiver outage while the cluster is running

**As a** cluster operator whose smee receiver dies mid-run (network drop, channel closed, receiver crashes),
**I want** the monitors to escalate to fast-poll on genuine staleness and recover to base cadence when events resume,
**So that** a broken real-time leg doesn't silently strand the cluster on the safety-net cadence.

**Acceptance Criteria**:
- [ ] When no webhook event has been recorded for the staleness window, the affected monitor's `decideAdaptivePoll` returns `reason: 'webhook-stale'` and switches to the fast interval.
- [ ] When webhook events resume, `decideAdaptivePoll` returns `reason: 'webhook-recovered'` and the monitor returns to base cadence.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Each of the four monitor services (`LabelMonitorService`, `PrFeedbackMonitorService`, `MergeConflictMonitorService`, `ClarificationAnswerMonitorService`) exposes a **one-way** runtime method `setWebhooksConfigured(true, opts?: { basePollIntervalMs?: number })` that (a) sets `state.webhooksConfigured = true`, (b) sets `currentPollIntervalMs` to `opts.basePollIntervalMs ?? config.smee.fallbackPollIntervalMs`, and (c) does **not** modify `options.adaptivePolling`. There is no `false` overload. | P1 | Q1=A, Q2=A |
| FR-002 | `startSmeePipeline(channelUrl)` invokes the FR-001 setter on every constructed monitor **once the smee receiver reports `Connected`** — not at function top, and not gated on webhook-registration success. | P1 | Q5=B |
| FR-003 | `ClarificationAnswerMonitorService` no longer hardcodes `webhooksConfigured: false`. Its constructor accepts `webhooksConfigured?: boolean = false` (matching `label-monitor-service.ts:99`), and the `server.ts` construction site passes `config.smee.channelUrl != null` explicitly (matching the `server.ts:493` pattern used by the other three). | P1 | Q4=C |
| FR-004 | Inbound-webhook wiring is verified for all four monitors' `recordWebhookEvent()`. Any monitor whose inbound path does not currently reach `recordWebhookEvent()` (from `SmeeWebhookReceiver` or the equivalent inbound dispatcher) is wired as part of this PR. | P1 | Q3=A (in scope, unconditional) |
| FR-005 | Once FR-001–FR-004 are in place, for each of the four monitors `decideAdaptivePoll` returns `reason: 'quiet'` on steady-state, `reason: 'webhook-stale'` on genuine staleness (setting `currentPollIntervalMs` to the fast interval), and `reason: 'webhook-recovered'` on recovery (back to base). It **never** returns `reason: 'webhooks-not-configured'` after `startSmeePipeline` has flipped the flag. | P1 | Direct consequence of FR-001(c) leaving `adaptivePolling=true` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Monitors on the auto-provisioned path polling at fallback cadence after receiver-connect | 4/4 monitors | Structured log inspection: `currentPollIntervalMs == fallbackPollIntervalMs` and `reason != 'webhooks-not-configured'` after the `Connected to smee.io channel` line |
| SC-002 | `Webhooks appear unhealthy … reason=webhooks-not-configured` log lines emitted post-receiver-connect | 0 | Log grep on a preview cluster over a 5-minute window after receiver-connect |
| SC-003 | GitHub App-installation-token GraphQL requests per minute on a steady-state cluster (idle, no work) | Bounded by fallback cadence (4× monitors ÷ fallback interval), not fast cadence (4× ÷ 10s) | Rate-limit headers on outbound gh/graphql calls, sampled over a 5-minute idle window |
| SC-004 | Real GitHub webhook delivery observed as `source: 'webhook'` on the corresponding monitor's ingest | 1/1 for each event family (`issues`, `pull_request`, PR review) | Structured log inspection after firing a synthetic event of each family |

## Assumptions

- `config.smee.fallbackPollIntervalMs` already exists on the config schema and is a reasonable safety-net cadence; the setter uses it as the default `basePollIntervalMs`.
- The smee receiver emits a `Connected` signal that `startSmeePipeline` can await/observe before invoking the FR-001 setter (existing behaviour on the static path; verify for the auto-provisioned path).
- The controller-matrix invariant "when `webhooksConfigured=true`, staleness/recovery branches govern regardless of `adaptivePolling`" (see `adaptive-poll-controller.ts:90-166`) holds — Q2's rationale depends on it.
- No downstream consumer of `ClarificationAnswerMonitorService`'s constructor relies on the 4-arg positional signature that would be broken by inserting a new **required** parameter. FR-003 picks the optional-with-default shape (Q4=C) to preserve backward compatibility regardless.
- `startSmeePipeline` is called on **all** channel-source paths (static, persisted, auto-provisioned). This is the current behaviour; the bug is that only the static path also flips the construction-time gate.

## Out of Scope

- Bidirectional `setWebhooksConfigured(false, …)` for smee-receiver-failure recovery. Handled by the existing `webhook-stale → to-fast` / `webhook-recovered → to-base` controller path (Q1=A, Q2=A).
- Refactoring monitor construction to defer until after channel resolution. Explicitly rejected as too invasive; runtime setter is the surgical fix.
- Any change to the adaptive-poll controller matrix (`adaptive-poll-controller.ts`) itself. The fix works by feeding the controller different inputs, not by changing its decision logic.
- Companion operator-doorbell reuse of the same channel (generacy-ai/generacy#988). Separate PR.
- Cloud-side or webhook-registration path changes (already covered by #952, #972).

---

*Generated by speckit*
