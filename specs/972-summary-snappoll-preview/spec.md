# Feature Specification: ## Summary

On the snappoll preview cluster, the orchestrator **auto-provisions and connects a smee

**Branch**: `972-summary-snappoll-preview` | **Date**: 2026-07-17 | **Status**: Draft

## Summary

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

## Acceptance
- [ ] A provisioned-smee cluster registers its repo webhook successfully (or fails loud with an actionable remediation, not a silent poll-fallback).
- [ ] `LabelMonitorService` stops polling when smee is live (no `pollRepo` rate-limit errors during a nominal run).
- [ ] (P2) PR/check transitions arrive via smee; pr-feedback + merge-conflict monitors no longer poll on smee-live clusters.

## Related
- **#970** — cockpit auto GraphQL exhaustion (operator-PAT side); its doorbell (FR-011) depends on a *live* webhook stream, which this issue provides.
- `generacy/CLAUDE.md` #952/#953 — smee channel auto-provisioning + adaptive polling for smee-less clusters.


## User Stories

### US1: Preview-cluster operator sees the webhook gap instead of a silent poll-fallback

**As a** preview-cluster operator (e.g., the snappoll cluster today),
**I want** the orchestrator to either successfully register the GitHub repo webhook against the provisioned smee channel, or fail loud with an actionable reason surfaced to the cloud UI,
**So that** I never end up in the current failure mode — smee connected, no webhook, orchestrator silently exhausting the GitHub App installation token via LabelMonitor polling.

**Acceptance Criteria**:
- [ ] On a fresh boot with `admin:repo_hook` granted, the orchestrator registers a repo webhook whose payload URL equals the provisioned smee channel URL, with events `issues`, `pull_request`, `check_run`, `check_suite`, content-type `application/json`.
- [ ] On a 403 from `admin:repo_hook` at webhook-registration time, the orchestrator emits a distinct structured warn log line AND a `cluster.bootstrap` relay event `{ status: 'failed', reason: 'webhook-registration-forbidden', repo, installationId, missingScope: 'admin:repo_hook' }`, and the cluster transitions to `degraded` with `statusReason: 'webhook-registration-forbidden'` (it does NOT stay silently `ready`, and does NOT go to `error`).
- [ ] When smee is live for the cluster's watched repos, `LabelMonitorService.pollRepo` produces zero installation-token rate-limit errors during a nominal one-hour run.

### US2: Existing pre-fix cluster heals itself when the App gains the missing permission

**As an** operator of a cluster that was booted before the App had `admin:repo_hook`,
**I want** the fix to apply on the next orchestrator restart without state migration or manual webhook creation,
**So that** rolling out the App permission grant plus a redeploy is sufficient to repair the whole fleet.

**Acceptance Criteria**:
- [ ] After the App is granted `admin:repo_hook`, restarting the cluster (`generacy up` cycle) causes `ensureWebhooks()` to register the missing webhook on next start with no additional operator action.
- [ ] Release notes call out "restart to repair" as the documented remediation.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `WebhookSetupService.ensureWebhooks()` MUST attempt to register a repo webhook for every watched repo on every orchestrator start, using the currently-provisioned smee channel URL as the payload URL, content-type `application/json`, and events `issues`, `pull_request`, `check_run`, `check_suite`. | P1 | Existing service — this locks its behavior against the current live bug. |
| FR-002 | On HTTP 403 (`Resource not accessible by integration`) from webhook registration or hook-listing, the orchestrator MUST emit both (a) a distinct structured warn log line naming the missing scope `admin:repo_hook` and the repo, and (b) a `cluster.bootstrap` relay event `{ status: 'failed', reason: 'webhook-registration-forbidden', repo, installationId, missingScope: 'admin:repo_hook' }`. Silent poll-fallback is prohibited. | P1 | Payload shape locked by Q1→A. |
| FR-003 | On a webhook-registration 403 at startup, the cluster status MUST transition to `degraded` with `statusReason: 'webhook-registration-forbidden'`. The orchestrator MUST continue running (polling stays as the safety-net fallback). | P1 | Q3→B. Not `ready` (silent), not `error` (halt), not env-configurable. |
| FR-004 | When a webhook already exists on the target repo, `ensureWebhooks()` MUST update it to the current channel URL only when the existing hook's `config.url` exactly matches a previously-persisted Generacy channel URL (from `.agency/` or cluster-local state); otherwise it MUST log-and-skip without modifying the hook. Never touch a hook we did not create. | P1 | Q2→B. Extends existing "skip if hook for current URL exists" behavior to heal stale-channel-rotation cases. |
| FR-005 | On a smee-live cluster (webhook registered, channel connected), `LabelMonitorService.pollRepo` MUST NOT produce installation-token rate-limit errors during a nominal one-hour run. | P1 | Observable-outcome anchor; measurable via orchestrator logs. |
| FR-006 | The `cluster.bootstrap` relay event from FR-002 MUST reach the cloud UI over the existing `/internal/relay-events` IPC path so the dashboard can render a banner indicating the permission gap. | P1 | Q1→A. Reuses existing channel + IPC — no new relay channel required. |
| FR-007 | The implementation MUST record, under a `## Diagnosis` section in `plan.md`, whether the `admin:repo_hook` gap is snappoll-specific or systemic to every Generacy App installation, arrived at by inspecting the Generacy GitHub App's declared permission manifest. A scratch-repo test webhook registration MUST additionally validate end-to-end that granting the scope actually fixes it. | P1 | Q5→A. Doubles as SC-003 validation. |
| FR-008 | Pre-fix clusters (those booted before the App had `admin:repo_hook`) MUST heal automatically on the next orchestrator restart via the existing per-start `ensureWebhooks()` call; no state migration and no zero-restart in-place repair path is required. | P2 | Q4→A. Zero-restart repair via a `cluster.webhooks refresh-requested` message deferred to a follow-up. |
| FR-009 | (P2) `SmeeWebhookReceiver` SHOULD be extended to handle `pull_request`, `check_run`, and `check_suite` actions and route them to `PrFeedbackMonitorService` and `MergeConflictMonitorService`, so those monitors stop polling on smee-live clusters. | P2 | Follow-on; explicitly out of scope for the P1 fix per spec's Fix section. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Installation-token rate-limit errors from `LabelMonitorService.pollRepo` during a one-hour nominal run on a smee-live cluster. | 0 | Grep orchestrator logs for `API rate limit already exceeded for installation ID` across a 1h window after fresh boot. |
| SC-002 | Webhook-registration 403 events not silently absorbed. | 100% of 403s produce both a warn log line AND a `cluster.bootstrap` relay event with `reason: 'webhook-registration-forbidden'` AND a cluster status transition to `degraded`. | Force-simulate a 403 in a scratch cluster; verify all three signals. |
| SC-003 | Scratch-repo end-to-end validation. | Granting `admin:repo_hook` on a scratch App install allows `ensureWebhooks()` to successfully create a webhook and receive the initial `ping` event through smee. | Manual: install App on scratch repo, boot cluster, observe hook create + smee `ping` delivery. |
| SC-004 | Pre-fix cluster self-heal. | A cluster that booted without `admin:repo_hook`, after App permission grant + `generacy up` restart, has a registered webhook whose payload URL equals the currently-provisioned smee channel URL, with no operator action beyond the restart. | Verify via `gh api repos/{owner}/{repo}/hooks` after restart. |
| SC-005 | Diagnosis artifact exists. | `plan.md` contains a `## Diagnosis` section stating whether the scope gap is snappoll-specific or systemic, grounded in App-manifest inspection. | Read `plan.md`; presence check. |

## Assumptions

- The orchestrator already provisions and connects a smee channel correctly (evidence section confirms this on the snappoll cluster); the fix is narrowly about the webhook-registration step that feeds the connected channel.
- The Generacy GitHub App uses installation tokens from installation ID `113597939` on snappoll; the `admin:repo_hook` scope, once declared in the App manifest, propagates to every existing installation automatically (no per-install re-consent needed for App permissions the operator did not de-scope).
- `.agency/` (or an equivalent cluster-local marker) already persists the current provisioned smee channel URL, giving FR-004's exact-URL match a source of truth. If it does not, the plan phase must add persistence as part of FR-004.
- Polling remains a safety net for the `webhook-dropped` / `never-lived` cases even after the fix; adaptive polling for smee-less clusters (CLAUDE.md #953) is orthogonal and out of scope here.
- `WebhookSetupService`, `SmeeWebhookReceiver`, `LabelMonitorService`, and the `cluster.bootstrap` relay channel exist and are wired end-to-end today — this issue extends observable behavior on failure, not the transport.

## Out of Scope

- Extending `SmeeWebhookReceiver` to handle `pull_request` / `check_run` / `check_suite` and rewiring `PrFeedbackMonitorService` + `MergeConflictMonitorService` off polling (tracked as FR-009, P2 follow-on).
- Fixing the operator-PAT GraphQL exhaustion in cockpit auto (#970) — a distinct budget with a distinct root cause.
- Adaptive polling engagement changes for smee-less clusters (CLAUDE.md #953).
- Adding a zero-restart in-place webhook repair path via a `cluster.webhooks refresh-requested` relay message (Q4 option B — deferred).
- Introducing a new `cluster.webhooks` relay channel (Q1 option C — rejected in favor of reusing `cluster.bootstrap`).
- Env-var-configurable failure modes for webhook registration (Q3 option D — rejected as premature flexibility).

---

*Generated by speckit*
