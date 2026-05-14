# Bugfix: Stale credential surface after cluster re-add and credential refresh

**Branch**: `614-symptom-user-flow-cloud` | **Issue**: #614 | **Date**: 2026-05-14 | **Status**: Draft | **Type**: Bugfix

## Summary

When a user archives a cluster and re-adds it via `npx generacy launch --claim=<new-claim>`, the orchestrator boots with a stale API key from the previous activation (Problem 1) and continues using expired GitHub credentials forever (Problem 2). Even though the cloud successfully PUTs fresh credentials to the cluster on every WebSocket reconnect, the cluster never re-surfaces the new token into `gh auth`'s config — causing perpetual 401 errors on all GitHub API calls.

Two independent cluster-side fixes are required:

- **Fix A** (high-priority): `handlePutCredential` must re-run `gh auth login --with-token` when a github-app or github-pat credential is updated, so the orchestrator's `gh` CLI picks up the new token immediately.
- **Fix B** (medium-priority): The activation flow must not skip device-code activation when a stale key file exists but the cluster is being re-initialized with a new claim code.

## Root Cause Analysis

### Problem 1 — Activation skip gates on key-file presence alone

`packages/orchestrator/src/activation/index.ts` short-circuits the entire device-code flow if `/var/lib/generacy/cluster-api-key` exists on disk. When docker volumes survive a `docker compose down` + re-add, the stale key file causes the orchestrator to skip wizard-mode activation entirely — no credential delivery, no `bootstrap-complete`, no fresh environment.

### Problem 2 — `handlePutCredential` doesn't re-surface GH_TOKEN

`packages/control-plane/src/routes/credentials.ts` persists credentials to the encrypted store and emits relay events, but does not:
- Rewrite `/var/lib/generacy/wizard-credentials.env` with the new token
- Re-run `gh auth login --with-token` to update `~/.config/gh/hosts.yml`

The `gh` CLI reads from `hosts.yml` on every invocation. Without updating it, all GitHub API calls use the stale token from the original wizard run.

## User Stories

### US1: Cluster re-add works without manual intervention

**As a** platform user,
**I want** to archive a cluster and re-add it with a new claim code,
**So that** the new cluster boots with fresh credentials and GitHub API calls succeed immediately.

**Acceptance Criteria**:
- [ ] Orchestrator detects stale activation state when re-launched with a new claim and re-runs device-code flow
- [ ] GitHub API calls succeed on the first PR-monitor poll after re-add

### US2: Credential refresh on reconnect takes effect immediately

**As a** platform user,
**I want** credential refreshes delivered by the cloud (via `PUT /credentials/:id`) to take effect immediately,
**So that** I don't experience perpetual 401 errors when installation tokens rotate.

**Acceptance Criteria**:
- [ ] After `PUT /credentials/github-main-org` with a new token, the next `gh` CLI invocation uses the new token
- [ ] The env file `/var/lib/generacy/wizard-credentials.env` is regenerated with the updated `GH_TOKEN`
- [ ] `~/.config/gh/hosts.yml` is updated with the new token

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `handlePutCredential` re-runs `writeWizardEnvFile()` after persisting a github-app or github-pat credential | P1 | Fix A — load-bearing change |
| FR-002 | `handlePutCredential` invokes `gh auth login --with-token` (or writes `hosts.yml` directly) after persisting a github-app or github-pat credential | P1 | Fix A — makes `gh` pick up new token |
| FR-003 | Credential refresh logic is scoped to `github-app` and `github-pat` types only; other types (anthropic-api-key, etc.) are unaffected | P1 | No regressions for non-GitHub credentials |
| FR-004 | Activation skip in `activate()` considers credential health, not just key-file presence | P2 | Fix B — stale key file detection |
| FR-005 | When CLI passes `--claim`, treat as explicit re-activation signal; ignore existing key file | P2 | Fix B — simpler variant; user intent is clear |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `PUT /credentials/github-main-org` with type `github-app` results in updated `hosts.yml` | 100% | Unit test: verify `gh auth login --with-token` is invoked or `hosts.yml` updated |
| SC-002 | `PUT /credentials/github-main-org` with type `github-app` results in updated env file | 100% | Unit test: verify `GH_TOKEN=` line in env file matches new token |
| SC-003 | Re-add flow (archive → new claim → launch) completes wizard and delivers fresh credentials | 100% | Manual test: orchestrator's first PR-monitor poll succeeds without 401 |
| SC-004 | Normal cluster restart (no re-add) continues to skip activation as before | 100% | Regression test: existing key + existing credentials = skip activation |

## Assumptions

- Cloud-side `generacy-cloud#568` (refresh-on-reconnect via PUT) is deployed and working. This fix makes the cluster act on those PUTs.
- `gh auth login --with-token` is available in the cluster-base container image.
- The control-plane process has filesystem access to `~/.config/gh/hosts.yml` (same user context as the orchestrator).
- Docker named volumes persist across `docker compose down` (confirmed behavior).

## Out of Scope

- **Fix C** — Orchestrator's GitHub client minting tokens on-demand via credhelper-daemon (tracked under #572)
- Cloud-side changes (already shipped in `generacy-cloud#568`)
- Cluster-base entrypoint script changes (the fix works at the control-plane application layer)
- Credential rotation for non-GitHub credential types

## Related Issues

- `generacy-ai/generacy-cloud#567` — Cloud-side root cause discussion
- `generacy-ai/generacy-cloud#568` — Cloud-side refresh-on-reconnect (does its job; cluster doesn't act on it)
- #547 — Initial mint-at-wizard-time on cloud
- #589 / #591 — Cluster-side `wizard-env-writer` that consumes the initial wizard delivery
- #572 — Umbrella: cluster-to-cloud connection contract (Fix C lives here)

## Test Plan

- [ ] Unit test: PUT `type: 'github-app'` credential → verify env file `GH_TOKEN=` rewritten with new token
- [ ] Unit test: PUT `type: 'github-app'` credential → verify `gh auth login --with-token` invoked / `hosts.yml` updated
- [ ] Unit test: PUT `type: 'api-key'` credential → verify no env file rewrite or `gh auth` invocation
- [ ] Unit test: Activation with existing key file but missing `credentials.yaml` → falls through to device-code flow
- [ ] Unit test: Activation with existing key file and valid `credentials.yaml` → skips activation (regression guard)
- [ ] Manual: Archive cluster → re-add with new claim → verify orchestrator's first PR-monitor poll succeeds
- [ ] Manual: PUT fresh credential to running cluster → next `gh` invocation uses new token

---

*Generated by speckit*
