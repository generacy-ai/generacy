# Feature Specification: Cluster-Side GH_TOKEN Expiry Detection and Refresh Backstop

**Issue**: [generacy-ai/generacy#762](https://github.com/generacy-ai/generacy/issues/762)
**Branch**: `762-summary-when-cluster-s` | **Date**: 2026-06-05 | **Status**: Draft

## Summary

When the cluster's GitHub App installation token expires, the orchestrator's monitors (`LabelMonitorService`, `PrFeedbackMonitorService`) silently retry `HTTP 401: Bad credentials` indefinitely with no recovery and no operator-visible signal. The cluster must (a) detect expiry proactively and request a fresh credential from the cloud over the relay, and (b) fail **loudly** at the default log level / health surface when the token is dead. This is the cluster-side complement to the cloud-side refresh chain bug tracked in `generacy-ai/generacy-cloud#813`.

## Why

Installation tokens have a ~1h TTL. The cloud pushes refreshed credentials via the relay → control-plane (`PUT /credentials/:id`) → `wizard-credentials.env` → `wizard-creds-token-provider.ts` (mtime cache). When that cloud refresh chain breaks (see `generacy-cloud#813`), the cluster has **no fallback**:

- `wizard-creds-token-provider.ts` (packages/orchestrator/src/services/wizard-creds-token-provider.ts:30) only *reads* `GH_TOKEN`; it has access to the sealed credential's `expiresAt` metadata via `.agency/credentials.yaml` but never acts on it.
- `LabelMonitorService.pollRepo()` (packages/orchestrator/src/services/label-monitor-service.ts:489) catches `HTTP 401` as a generic `"Error polling repository"` and continues the loop. Same pattern in `PrFeedbackMonitorService`.
- The 30s/60s poll cadence means the cluster emits one identical log line per minute forever; operators cannot distinguish this from "no work to do".

**Observed incident** (`ai-lawfirm`): token expired ~1h after activation, monitors 401-looped silently, container restart did not help because the cloud never pushed a fresh token.

## User Stories

### US1: Operator sees auth failure as a distinct, actionable signal

**As an** operator monitoring a cluster
**I want** GitHub token authentication failures to surface as a distinct error state (log + health endpoint + relay event)
**So that** I can distinguish "the cluster is healthy but idle" from "the cluster is wedged due to expired credentials" without enabling debug logging.

**Acceptance Criteria**:
- [ ] On a sustained 401 from GitHub, a single, distinct warn/error log line is emitted (not the generic `"Error polling repository"`).
- [ ] `/health` exposes a boolean or status field indicating GitHub auth is failing.
- [ ] A relay event (e.g. `cluster.credentials` with `status: 'auth-failed'` or similar) is emitted so the cloud UI can reflect the state.
- [ ] The state resolves automatically when a fresh token arrives and the next call succeeds.

### US2: Cluster proactively requests credential refresh

**As a** cluster
**I want** to proactively request a credential refresh from the cloud over the relay when my GitHub App token has expired or is about to expire
**So that** I recover from cloud-side refresh chain failures without operator intervention or a full reconnect.

**Acceptance Criteria**:
- [ ] When `expiresAt` from `.agency/credentials.yaml` indicates the token is past or near expiry (e.g. <5 min remaining), the cluster emits a refresh request to the cloud via the relay.
- [ ] When a monitor receives a 401 from GitHub, the cluster emits a refresh request to the cloud via the relay (regardless of `expiresAt`).
- [ ] Refresh requests are rate-limited so a wedged cloud doesn't get spammed (e.g. minimum 60s between requests per credential).

### US3: Monitors distinguish auth failure from transient errors

**As a** monitor service
**I want** to handle a `401 Bad credentials` differently from network/transient errors
**So that** I do not mask a fatal auth condition as a routine poll failure.

**Acceptance Criteria**:
- [ ] `LabelMonitorService.pollRepo()` catches `401` distinctly and routes to the auth-failure path.
- [ ] `PrFeedbackMonitorService` does the same.
- [ ] Both services continue to handle transient/network errors as before (loop with generic log).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `wizard-creds-token-provider` (or a new sibling service) reads `expiresAt` from `.agency/credentials.yaml` for the github-app credential | P1 | Source of truth for proactive expiry detection. |
| FR-002 | A new orchestrator service detects token expiry/near-expiry and emits a `cluster.credentials` relay event requesting refresh | P1 | Channel name TBD during planning. |
| FR-003 | `LabelMonitorService.pollRepo()` distinguishes `HTTP 401` from other errors and emits a distinct auth-failure log + relay event | P1 | Touches packages/orchestrator/src/services/label-monitor-service.ts:489. |
| FR-004 | `PrFeedbackMonitorService` applies the same 401 handling | P1 | Symmetric with FR-003. |
| FR-005 | On 401, the orchestrator triggers a refresh request via the relay (in addition to logging) | P1 | Closes the recovery loop. |
| FR-006 | Refresh requests are rate-limited (e.g. min 60s per credential) | P2 | Prevents spamming a degraded cloud. |
| FR-007 | `/health` endpoint includes a `githubAuthHealthy: boolean` field | P2 | Operator-visible health signal. |
| FR-008 | Auth-failed state automatically clears when the next GitHub call succeeds | P1 | No manual reset; recovery is self-healing once a fresh token arrives. |
| FR-009 | Existing 401 vs. non-401 error classification must work with the github client abstraction (`gh-cli.ts`) — surface HTTP status from `gh` CLI errors | P1 | The `gh` CLI prints status in stderr; needs reliable parsing. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Time-to-detect expired token (post-expiry) | < 2 minutes | Manual test: expire token, observe first auth-failure log + relay event. |
| SC-002 | Operator can identify "auth failure" vs "idle" from default-level logs only | Yes | Inspect logs at default level during a synthetic auth failure. |
| SC-003 | Cluster recovers automatically when cloud pushes a fresh token after a sustained auth-failed state | Yes (no restart needed) | Manual test: induce 401, push fresh token, observe monitors resume. |
| SC-004 | Cloud receives at most 1 refresh-request relay event per credential per 60s during sustained 401 | Yes | Count `cluster.credentials` refresh events over a 5-min synthetic failure window. |

## Assumptions

- The cloud refresh chain is being fixed in parallel (`generacy-cloud#813`). This work is the cluster-side backstop, not a replacement.
- `.agency/credentials.yaml` reliably contains `expiresAt` for github-app credentials when they are sealed by the wizard / cloud refresh.
- The relay supports cluster-to-cloud events on `cluster.credentials` (already used for credential-written notifications).
- A 401 from `gh` CLI invocations is reliably detectable from stderr / exit code (to be verified during planning).
- The `wizard-credentials.env` mtime-based cache invalidation in `wizard-creds-token-provider.ts` continues to work — this spec adds detection/escalation on top, not a replacement for the existing read path.

## Out of Scope

- The cloud-side refresh chain fix (covered by `generacy-cloud#813`).
- Cluster-side minting of GitHub App tokens (cluster does not hold the app private key).
- Persisting refreshed tokens across container restarts beyond what `wizard-credentials.env` already provides.
- Replacing the existing `wizard-creds-token-provider` mtime-cache mechanism.
- Adding refresh logic for non-GitHub credentials (anthropic, etc.) — github-app is the only one with the silent-401 failure mode today.
- Webhook-based GitHub auth signaling (this spec is poll-based monitor scope).

## Related

- Primary cloud-side fix: `generacy-ai/generacy-cloud#813` — refresh chain bootstrapped only on a successful on-connect refresh; breaks permanently on any null; silent failures.
- Cluster code touched:
  - `packages/orchestrator/src/services/wizard-creds-token-provider.ts`
  - `packages/orchestrator/src/services/label-monitor-service.ts`
  - `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
  - `packages/orchestrator/src/routes/internal-relay-events.ts` (existing IPC channel for cluster→cloud events)
  - `packages/orchestrator/src/routes/health.ts`
  - `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (401 detection from `gh` CLI)

---

*Generated by speckit*
