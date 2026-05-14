# Feature Specification: ## Summary

`PrFeedbackMonitorService` and `LabelMonitorService` invoke GitHub through `GhCliGitHubClient`, which shells out to `gh` and relies on ambient environment / `~/

**Branch**: `620-summary` | **Date**: 2026-05-14 | **Status**: Draft

## Summary

## Summary

`PrFeedbackMonitorService` and `LabelMonitorService` invoke GitHub through `GhCliGitHubClient`, which shells out to `gh` and relies on ambient environment / `~/.config/gh/hosts.yml`. The token in that file is only kept fresh by external pushes from the cloud (`PUT /control-plane/credentials/github-main-org` → `handlePutCredential` → `refreshGhAuth` → `gh auth login --with-token`).

That works when the cloud-side refresh path is healthy, but it leaves the in-cluster GitHub monitors structurally dependent on cloud pushes for liveness. Meanwhile credhelper — which the orchestrator already uses for conversation/worker processes — has a `github-app` plugin that mints and refreshes installation tokens at 75% TTL locally (`packages/credhelper-daemon/src/plugins/core/github-app.ts:49-118`). The orchestrator monitors don't use it.

This is a follow-up to generacy-cloud #577 (proactive cloud-side refresh). #577 unblocks the immediate symptom; this issue is the architectural cleanup that decouples the monitors from \`gh auth\` state entirely.

## Current shape

- `GhCliGitHubClient.listOpenPullRequests` / `listIssuesWithLabel` (`packages/workflow-engine/src/actions/github/client/gh-cli.ts`) spawn `gh` with no explicit `GH_TOKEN` in the spawn env — they rely on what `gh` finds ambiently.
- `PrFeedbackMonitorService.pollRepo` (`packages/orchestrator/src/services/pr-feedback-monitor-service.ts:310`) and `LabelMonitorService.pollRepo` (`packages/orchestrator/src/services/label-monitor-service.ts:442`) call `this.createClient()` — a factory that returns a `GhCliGitHubClient` with no token.
- Wired up in `packages/orchestrator/src/server.ts:271-304` — the monitors receive a `createGitHubClient` factory, never a credential.

Compare with conversation spawning in `packages/orchestrator/src/launcher/credentials-interceptor.ts:62-89`, which goes through credhelper and gets refreshable session-scoped credentials.

## Why it matters even after #577 ships

- The cluster's GitHub access becomes resilient to transient cloud refresh failures (cloud restart, redeploy, etc.) instead of going dark for up to a token TTL.
- Removes a confusing duplication — credhelper for workflow processes, ambient `gh auth` for orchestrator monitors. Same kind of credential, two delivery paths.
- The first-activation race (PID 1 boots before `wizard-credentials.env` exists, so `GH_TOKEN` is never in the orchestrator process env — works today only because `gh` falls through to hosts.yml) goes away.

## Suggested directions

**Option A — minimal, transitional:**
- Change `GhCliGitHubClient` to accept a `tokenProvider: () => Promise<string>` and explicitly set `GH_TOKEN` in the spawn env for each call.
- Monitor services pass a provider that reads from credhelper (or, transitionally, re-reads `wizard-credentials.env` on each call).
- Pro: small surface change, request-time freshness; con: still leaves credhelper integration partial.

**Option B — architectural:**
- Wire the monitor services through credhelper's session API the same way `credentials-interceptor.ts` does for spawned processes — assign each monitor a credential role, fetch a session dir per poll cycle, source its `env`.
- Two sub-options for where the installation token comes from:
  - **B1**: deliver the GitHub App private key to the cluster so the credhelper's `github-app` plugin mints tokens locally (security tradeoff — App key on disk in cluster).
  - **B2**: add a credhelper backend that fetches a fresh installation token from the cloud on demand (no key in cluster, but more network coupling).

B2 keeps the App key in the cloud while still letting the cluster pull tokens just-in-time rather than rely on push.

A reasonable rollout might be A first (low risk, immediate benefit), then B2 if/when the architectural cleanup is prioritized.

## File refs

- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — `executeCommand('gh', …)` with ambient env
- `packages/workflow-engine/src/actions/cli-utils.ts:~150` — `spawn(…, { env: { ...process.env, ...env } })`
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:310`
- `packages/orchestrator/src/services/label-monitor-service.ts:442`
- `packages/orchestrator/src/server.ts:271-304`
- `packages/orchestrator/src/launcher/credentials-interceptor.ts:62-89` — credhelper integration pattern to mirror
- `packages/credhelper-daemon/src/plugins/core/github-app.ts:49-118` — existing plugin with refresh

## Related

- generacy-cloud #577 — proactive cloud-side token refresh (the immediate blocker; this issue is the architectural follow-up)
- generacy #614 — `handlePutCredential` writes env file + refreshes `gh auth` (will continue to work; this issue would replace its role for the monitor path)
- generacy #589 — wizard env delivery

## User Stories

### US1: Resilient GitHub Monitoring

**As a** cluster operator,
**I want** orchestrator GitHub monitors to resolve credentials at poll time from the wizard-credentials env file,
**So that** monitors remain functional even when cloud-side token refresh is temporarily unavailable.

**Acceptance Criteria**:
- [ ] `GhCliGitHubClient` accepts a required `tokenProvider: (() => Promise<string>) | undefined` parameter and sets `GH_TOKEN` in spawn env when provided
- [ ] `PrFeedbackMonitorService`, `LabelMonitorService`, `LabelSyncService`, and `WebhookSetupService` all use a token provider that reads from `/var/lib/generacy/wizard-credentials.env`
- [ ] Worker-process callers (`claude-cli-worker.ts`, `pr-feedback-handler.ts`) pass `undefined` for tokenProvider (they use credhelper session env)
- [ ] When token resolution fails, the monitor skips that poll cycle, logs a warning, and retries at normal interval
- [ ] Log on state transition (started failing / resumed) rather than every cycle

### US2: Explicit Token Injection API

**As a** developer working on orchestrator code,
**I want** `GhCliGitHubClient` to require an explicit token provider parameter,
**So that** every callsite must consciously decide how GitHub credentials are sourced, preventing silent regression to ambient auth.

**Acceptance Criteria**:
- [ ] `GitHubClientFactory` type signature includes `tokenProvider` as required parameter
- [ ] All existing callsites updated to pass either a provider or `undefined`
- [ ] No `gh` CLI invocation from orchestrator-process code relies on ambient `~/.config/gh/hosts.yml` for auth

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `tokenProvider: (() => Promise<string>) \| undefined` as required parameter to `GhCliGitHubClient` constructor | P1 | Breaking API change; all 5 callsites must be updated |
| FR-002 | When `tokenProvider` is set, `GhCliGitHubClient` calls it before each `gh` invocation and sets `GH_TOKEN` in spawn env | P1 | |
| FR-003 | Implement a wizard-credentials-env token provider that re-reads `/var/lib/generacy/wizard-credentials.env` on each call, parses `GH_TOKEN`, and returns it | P1 | File kept fresh by `handlePutCredential` (#614) |
| FR-004 | Wire all 4 orchestrator-process consumers (`PrFeedbackMonitorService`, `LabelMonitorService`, `LabelSyncService`, `WebhookSetupService`) to use the wizard-creds-env token provider | P1 | `WebhookSetupService` shells `gh` directly — set `GH_TOKEN` in `executeCommand` env |
| FR-005 | Worker-process callers pass `undefined` as tokenProvider | P1 | They run inside credhelper sessions with `GH_TOKEN` in env |
| FR-006 | On token resolution failure, skip poll cycle with warning log; log on state transition (started-failing / resumed) not every cycle | P2 | Prevents 240 warnings/hr during extended outages |
| FR-007 | Existing `handlePutCredential` → `refreshGhAuth` path continues to work for env file refresh | P2 | This is what keeps wizard-credentials.env fresh |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | No orchestrator-process `gh` invocation relies on ambient `hosts.yml` auth | 0 ambient auth paths | grep for `gh` spawn calls without `GH_TOKEN` in env |
| SC-002 | Monitors recover within one poll interval after cloud refresh resumes | ≤60s recovery | Token provider reads freshly-written env file on next poll |

## Assumptions

- `/var/lib/generacy/wizard-credentials.env` is kept fresh by `handlePutCredential` (#614) on cloud-pushed credential refreshes
- Cloud-side proactive refresh (#577) ships first or concurrently, ensuring the env file receives timely updates
- The wizard-credentials env file format includes `GH_TOKEN=<value>` (set by `mapCredentialToEnvEntries` in wizard-env-writer)
- Credhelper session-based token delivery for long-lived consumers is deferred to a follow-up issue (requires API extension)

## Out of Scope

- Credhelper daemon HTTP API integration for monitors (deferred — session model doesn't fit long-lived consumers without API extension)
- `ClusterLocalBackend.fetchSecret()` direct access from orchestrator process (breaks credhelper isolation boundary)
- Worker-process `gh` consumers (`claude-cli-worker.ts:218`, `pr-feedback-handler.ts:98`) — already use credhelper sessions
- Relay event emission for monitor credential failures (observability enhancement, separate issue)
- Option B1/B2 from original spec (GitHub App key in cluster / cloud-on-demand backend)

---

*Generated by speckit*
