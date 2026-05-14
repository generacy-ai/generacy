# Feature Specification: Orchestrator GitHub monitors credential resolution via credhelper

**Branch**: `620-summary` | **Date**: 2026-05-14 | **Status**: Draft

## Summary

`PrFeedbackMonitorService` and `LabelMonitorService` shell out to `gh` CLI for GitHub API calls but rely on ambient credential state (`~/.config/gh/hosts.yml`), which is only refreshed by cloud-pushed `PUT /control-plane/credentials/github-main-org` calls. This creates a structural dependency on cloud liveness for in-cluster GitHub monitoring.

Meanwhile, credhelper — already used by the orchestrator for conversation/worker processes — has a `github-app` plugin that mints and refreshes installation tokens locally at 75% TTL. The monitors should use this same path instead of ambient `gh auth` state.

This is the architectural follow-up to generacy-cloud #577 (proactive cloud-side token refresh). #577 addresses the immediate symptom; this issue decouples monitors from `gh auth` state entirely.

## User Stories

### US1: Resilient GitHub monitoring

**As a** cluster operator,
**I want** the PR feedback and label monitors to resolve GitHub credentials through credhelper,
**So that** GitHub monitoring continues working even during transient cloud refresh failures.

**Acceptance Criteria**:
- [ ] `GhCliGitHubClient` accepts a `tokenProvider` and passes `GH_TOKEN` explicitly to each spawned `gh` process
- [ ] Monitor services supply a token provider backed by credhelper (or credential env file as transitional step)
- [ ] Monitors no longer depend on ambient `gh auth` state in `~/.config/gh/hosts.yml`

### US2: Unified credential delivery

**As a** platform developer,
**I want** a single credential delivery path for all GitHub access in the orchestrator,
**So that** the codebase doesn't have two divergent patterns (credhelper for workers, ambient `gh` for monitors).

**Acceptance Criteria**:
- [ ] Monitor credential flow follows the same pattern as `credentials-interceptor.ts`
- [ ] No ambient `gh auth` fallback in the monitor polling path

### US3: Boot-order independence

**As a** cluster operator,
**I want** monitors to resolve credentials at poll time (not at boot time),
**So that** the first-activation race (PID 1 boots before `wizard-credentials.env` exists) is eliminated.

**Acceptance Criteria**:
- [ ] Token is resolved per-poll-cycle, not cached from process startup env
- [ ] Monitors function correctly regardless of boot order relative to credential provisioning

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `GhCliGitHubClient` accepts `tokenProvider: () => Promise<string>` constructor option | P1 | Sets `GH_TOKEN` in spawn env per call |
| FR-002 | `PrFeedbackMonitorService` and `LabelMonitorService` supply a credhelper-backed token provider | P1 | Via `createGitHubClient` factory in `server.ts` |
| FR-003 | Token provider resolves credential at call time (not cached at construction) | P1 | Ensures freshness across poll cycles |
| FR-004 | Transitional provider can read from `wizard-credentials.env` if credhelper session unavailable | P2 | Fail-soft path for early boot |
| FR-005 | Existing `handlePutCredential` → `refreshGhAuth` path continues to work for non-monitor consumers | P1 | No regression for other `gh` CLI users |

## Approach

Recommended rollout: **Option A first** (minimal, transitional), then Option B2 if architectural cleanup is prioritized.

**Option A — tokenProvider injection (this issue)**:
- Add `tokenProvider: () => Promise<string>` to `GhCliGitHubClient`
- Set `GH_TOKEN` explicitly in spawned `gh` process env
- Monitor services pass a provider that reads from credhelper or re-reads credential env file

**Option B2 — full credhelper integration (follow-up)**:
- Wire monitors through credhelper session API (like `credentials-interceptor.ts`)
- Add credhelper backend that fetches installation tokens from cloud on demand
- Keeps App private key in cloud (no key on disk in cluster)

## Key Files

- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — `executeCommand('gh', …)` with ambient env
- `packages/workflow-engine/src/actions/cli-utils.ts:~150` — `spawn(…, { env: { ...process.env, ...env } })`
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:310` — `this.createClient()`
- `packages/orchestrator/src/services/label-monitor-service.ts:442` — `this.createClient()`
- `packages/orchestrator/src/server.ts:271-304` — monitor wiring with `createGitHubClient` factory
- `packages/orchestrator/src/launcher/credentials-interceptor.ts:62-89` — credhelper integration pattern to mirror
- `packages/credhelper-daemon/src/plugins/core/github-app.ts:49-118` — existing plugin with token refresh

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Monitor GitHub calls use explicit `GH_TOKEN` | 100% | No `gh` spawn without `GH_TOKEN` in env |
| SC-002 | Monitors survive cloud credential push outage | >= 1 token TTL | Kill cloud refresh, verify monitors keep polling |
| SC-003 | No ambient `gh auth` dependency in monitor path | 0 references | Code audit of monitor → client → spawn chain |

## Assumptions

- credhelper daemon is running and accessible via Unix socket in the orchestrator container
- `github-app` or `github-pat` credential type is provisioned during bootstrap wizard
- generacy-cloud #577 (proactive refresh) ships first or concurrently — this issue doesn't depend on it but complements it

## Out of Scope

- Option B1 (App private key on disk in cluster) — rejected for security reasons
- Option B2 (cloud-backed credhelper backend) — follow-up issue
- Changes to the cloud-side credential push path (`handlePutCredential` / `refreshGhAuth`)
- Non-GitHub credential flows in monitors

## Related Issues

- generacy-cloud #577 — proactive cloud-side token refresh (immediate blocker)
- generacy #614 — `handlePutCredential` writes env file + refreshes `gh auth`
- generacy #589 — wizard env delivery

---

*Generated by speckit*
