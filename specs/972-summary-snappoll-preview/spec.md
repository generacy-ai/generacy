# Feature Specification: Cluster smee webhook never registered — orchestrator polls → installation-token rate-limit exhaustion

**Branch**: `972-summary-snappoll-preview` | **Date**: 2026-07-17 | **Status**: Draft | **Issue**: [#972](https://github.com/generacy-ai/generacy/issues/972)

## Summary

On the snappoll preview cluster, the orchestrator **auto-provisions and connects a smee.io channel but the GitHub repo webhook is never registered** (permission gap), so GitHub delivers nothing to the channel. The orchestrator then silently falls back to polling and **exhausts its GitHub App installation token's rate limit**. This is a live ops bug and the prerequisite that blocks the whole event-driven path (see the cockpit doorbell work in #970).

## Evidence (snappoll cluster, `cluster-base:preview`, 2026-07-17)

Orchestrator provisions + connects the channel fine:
```
"Provisioned new smee channel URL"  channelUrl=https://smee.io/a3DLEAmEZiBZj6v  source=provisioned
"Smee webhook receiver configured"
"Connected to smee.io channel"      watchedRepos=["christrudelpw/snappoll"]
```
(`SMEE_CHANNEL_URL` env is empty; `WEBHOOK_SETUP_ENABLED=true`; channel persists across restarts via `source=persisted`.)

But webhook registration on the repo fails:
```
"Failed to list webhooks for repository"  stderr="gh: Resource not accessible by integration (HTTP 403)"
"Insufficient permissions to manage webhooks (admin:repo_hook required)"
```
So `christrudelpw/snappoll` has **no webhook** → the smee channel is connected-but-empty → GitHub never posts to it.

Consequence — the orchestrator polls and exhausts the **installation token** (a separate budget from any operator PAT):
```
LabelMonitorService.pollRepo → GraphQL: API rate limit already exceeded for installation ID 113597939
Error polling repository for clarification-answer pauses  → same
Error polling repository for merge-conflict pauses        → same
```

## Why this matters — two rate-limit budgets, one fixable cause

| Token | Consumer | Exhaustion cause |
|-------|----------|------------------|
| GitHub App installation `113597939` | orchestrator monitors (label / clarification / pr-feedback / merge-conflict / epic-completion) | **this bug** — no webhook → forced polling |
| operator PAT (`christrudelpw`) | cockpit `/cockpit:auto` + `gh` in workers | separate, tracked in #970 |

The orchestrator already treats polling as a safety net and disables adaptive polling when smee is configured (`packages/orchestrator/src/server.ts:470-473`). That design is correct — it's just never reached here because the webhook that feeds smee was never created.

## Fix

**P1 — register the webhook.** Either:
- Grant the GitHub App `admin:repo_hook` (repository *Webhooks: write*) so `WebhookSetupService.ensureWebhooks()` (`packages/orchestrator/src/services/webhook-setup-service.ts`) auto-creates it on next start — fixes it for every cluster the App provisions; **or**
- Create the webhook manually: payload URL = the cluster's provisioned smee channel, content-type `application/json`, events `issues`, `pull_request`, `check_run`, `check_suite`.

Confirm whether the permission gap is snappoll-specific or affects **every** App-provisioned cluster — if systemic, it's a standing reason clusters silently run poll-only (ties to the "adaptive polling for smee-less clusters" work, `generacy/CLAUDE.md` #953).

**P2 — full ingestion (follow-on).** Even with the webhook registered, `SmeeWebhookReceiver` only handles `action === 'labeled'` (`packages/orchestrator/src/services/smee-receiver.ts:216-217`) and feeds only `LabelMonitorService`. The pr-feedback and merge-conflict monitors are not smee-fed (per `generacy/CLAUDE.md` #953: their adaptive polling is effectively dead on smee clusters) and will keep polling for PR/check state. To fully retire orchestrator polling, extend the receiver to handle `pull_request` / `check_run` / `check_suite` and wire those monitors to it. P1 alone eliminates the dominant LabelMonitor 30s poll (the source of most of the errors above).

## User Stories

### US1: Cluster operator sees loud, actionable failure instead of silent poll-fallback

**As a** cluster operator provisioning a new cluster,
**I want** the orchestrator to fail loudly with actionable remediation when it cannot register the repo webhook,
**So that** I discover the permission gap during boot instead of hours later when the installation token is exhausted and workers stall.

**Acceptance Criteria**:
- [ ] When `WebhookSetupService.ensureWebhooks()` gets HTTP 403 (`admin:repo_hook`-scope missing), the orchestrator surfaces a distinct startup error/event (not just a swallowed `warn` log) that names the missing scope and points at the App installation page.
- [ ] The failure is visible to the operator (via structured log line, relay event on `cluster.bootstrap` or a similar channel, and/or `/health` field), not only in the orchestrator's own stdout.

### US2: Provisioned-smee cluster stops polling once webhook is live

**As a** cluster operator running an event-driven cluster with a live smee channel,
**I want** `LabelMonitorService` to stop 30s polling once the webhook is delivering,
**So that** the installation token's 5,000/hr GraphQL budget is not exhausted by redundant polling and workflows stop hitting rate-limit errors during nominal runs.

**Acceptance Criteria**:
- [ ] When smee is live (channel connected + repo webhook registered + at least one webhook delivery observed), `LabelMonitorService.pollRepo` does not emit rate-limit errors during a nominal 1-hour run.
- [ ] The webhook is registered by orchestrator boot (auto-repair path) or the operator has a documented one-shot manual creation flow that the orchestrator recognizes on next boot.

### US3 (P2, follow-on): PR + check events also flow through smee

**As a** cluster operator,
**I want** PR-feedback and merge-conflict monitors to consume `pull_request` / `check_run` / `check_suite` events from smee,
**So that** those monitors also stop polling on smee-live clusters and no orchestrator monitor is a standing rate-limit consumer.

**Acceptance Criteria**:
- [ ] `SmeeWebhookReceiver` handles `pull_request`, `check_run`, `check_suite` in addition to `labeled`.
- [ ] `PrFeedbackMonitorService` and `MergeConflictMonitorService` receive event notifications from the receiver (mirroring the LabelMonitor path) and do not poll on smee-live clusters.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On startup with `WEBHOOK_SETUP_ENABLED=true` and a provisioned smee channel, orchestrator MUST attempt to register the repo webhook pointing at the channel URL, content-type `application/json`, events `issues`, `pull_request`, `check_run`, `check_suite`. | P1 | Existing `WebhookSetupService.ensureWebhooks()` already does the attempt; requirement pins the event set + payload URL derivation. |
| FR-002 | If webhook registration returns HTTP 403 with `admin:repo_hook`-scope missing, orchestrator MUST fail loudly: distinct structured log line naming the missing scope AND a relay event on a bootstrap/health channel visible to the cloud UI. | P1 | Prevents silent poll-fallback; matches the "actionable remediation, not a silent poll-fallback" acceptance in issue body. |
| FR-003 | The loud-failure remediation message MUST name the required GitHub App permission (`Webhooks: write` / `admin:repo_hook`) and identify the installation ID (from failure context) so the operator can go directly to the App installation settings. | P1 | Actionability requirement. Installation ID is already available in error context (see issue evidence: `installation ID 113597939`). |
| FR-004 | When a webhook already exists on the target repo (any URL), orchestrator MUST detect it and either (a) update it to point at the current smee channel if it looks like a previous Generacy webhook, or (b) log a distinct warning identifying the existing webhook and skip creation. | P1 | Idempotency — `ensureWebhooks()` naming implies this is already the intent; requirement pins behavior. |
| FR-005 | With webhook live and smee connected, `LabelMonitorService` MUST NOT emit `pollRepo` GraphQL rate-limit errors during a nominal 1-hour run against a single-repo workspace. | P1 | Aligns with existing design (`server.ts:470-473` disables adaptive polling when smee is configured); requirement pins the observable outcome. |
| FR-006 | The webhook-registration failure state MUST be observable to the cloud UI via an existing relay channel (`cluster.bootstrap` or similar) so the wizard/cluster-detail view can surface it — same visibility model as other post-activation lifecycle failures. | P1 | Ensures the operator sees this in the cloud dashboard, not only in cluster-local logs. |
| FR-007 | Diagnose whether the `admin:repo_hook` permission gap is snappoll-specific or systemic (every App-provisioned cluster). Findings recorded in the plan/notes. | P1 | Per issue: "Confirm whether the permission gap is snappoll-specific or affects every App-provisioned cluster". |
| FR-008 | Extend `SmeeWebhookReceiver` to dispatch `pull_request`, `check_run`, `check_suite` events to their respective monitors (PrFeedback, MergeConflict). | P2 | Deferred follow-on per issue's P2 section. Not required for this feature to close, but tracked for scope decisions. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `LabelMonitorService.pollRepo` GraphQL rate-limit errors on a smee-live cluster during a nominal run | 0 | Grep orchestrator logs for `API rate limit already exceeded for installation ID` over a 1-hour interactive run on the fixed cluster. |
| SC-002 | Webhook registration failure surfaces to operator | ≥ 1 distinct structured event + operator-visible surface (relay channel / `/health`) on 403 | Manual test: revoke `admin:repo_hook` on a test App installation, boot orchestrator, verify the event fires. |
| SC-003 | Fresh App-provisioned cluster (post-fix) has a live webhook after boot | 100% of tested provisions | Provision one clean cluster end-to-end, confirm `gh api repos/<owner>/<repo>/hooks` returns the smee webhook. |
| SC-004 | Diagnosis of whether gap is snappoll-specific or systemic is documented | Yes/No answer + supporting evidence in plan | Written finding in `plan.md` under FR-007. |

## Assumptions

- The GitHub App used by Generacy clusters can be granted the `admin:repo_hook` (repository *Webhooks: write*) permission — this is a standard App permission, not a gap in GitHub's model.
- Once `admin:repo_hook` is granted, the existing `WebhookSetupService.ensureWebhooks()` machinery is correct and requires no logic changes beyond potentially tightening the failure-visibility path (FR-002/FR-006).
- The smee channel URL provisioned at boot is stable across restarts (evidence: `source=persisted` in logs) — so a webhook registered at boot N remains valid at boot N+1 without needing rotation.
- The two-budget rate-limit model in the issue (installation token vs. operator PAT) is accurate; fixing this issue addresses only the installation-token side and does not affect #970's PAT-side work.
- The cloud dashboard already renders `cluster.bootstrap` (or similar) relay events — the operator-visibility path exists and this issue only needs to emit onto it.

## Out of Scope

- Any changes to cockpit's cockpit-side rate-limit consumption (that's #970's territory — operator PAT).
- P2 work on extending `SmeeWebhookReceiver` to `pull_request` / `check_run` / `check_suite` and rewiring `PrFeedbackMonitorService` / `MergeConflictMonitorService` off polling. Captured as FR-008 for tracking, but this feature closes with P1 only unless plan/tasks explicitly pull P2 into scope.
- Removing polling as a safety-net fallback — polling stays as the "webhook dropped / never lived" fallback per existing architecture (`server.ts:470-473`). This feature only fixes the reachability of the webhook path.
- Adaptive-polling engagement for smee-less clusters (tracked separately per `generacy/CLAUDE.md` #953).
- Changes to the smee channel auto-provisioning path (tracked separately per `generacy/CLAUDE.md` #952).

## Related

- **#970** — cockpit auto GraphQL exhaustion (operator-PAT side); its doorbell (FR-011) depends on a *live* webhook stream, which this issue provides.
- `generacy/CLAUDE.md` #952/#953 — smee channel auto-provisioning + adaptive polling for smee-less clusters.

---

*Generated by speckit*
