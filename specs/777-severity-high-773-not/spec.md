# Feature Specification: JIT gh token provider must work without a `github-app` credential descriptor

**Branch**: `777-severity-high-773-not` | **Date**: 2026-06-06 | **Status**: Draft
**GitHub Issue**: [#777](https://github.com/generacy-ai/generacy/issues/777) | **Severity**: High (production regression)
**Workflow**: `speckit-bugfix`

## Summary

#773 introduced a Just-In-Time (JIT) GitHub token provider so that `gh` CLI calls in the orchestrator and worker would refresh tokens on demand via the control-plane `POST /git-token` endpoint, replacing the static 1-hour `GH_TOKEN` written to `/var/lib/generacy/wizard-credentials.env`. In production, the fix is a no-op: the provider is gated on the presence of a `github-app` credential descriptor in `.agency/credentials.yaml`, but wizard-bootstrapped clusters (all current production clusters) never have such a descriptor. They carry only the raw `GH_TOKEN`/`GH_USERNAME`/`GH_EMAIL` env values seeded by the wizard. Without the descriptor, `githubAppCredentialId` is `undefined`, the provider is never created, and every `gh` call inherits the ambient (expired-after-1h) `GH_TOKEN`. After roughly one hour the cluster begins 401-ing on every `gh` operation (label sync, label monitor, PR feedback monitor, worker `gh` calls) — exactly the failure mode #773 was meant to retire.

The control-plane `/git-token` endpoint itself works credential-less: `git-credential-generacy` (the git helper for HTTPS clones) calls `JitGitTokenClient.fetch()` with no argument and the control plane resolves the installation server-side from the cluster API key. The `git` path therefore continues to function. The fix is to drop the gating on a `github-app` descriptor, build the gh JIT provider whenever the control-plane socket is reachable, and call `fetch()` credential-less when no descriptor is present.

## User Stories

### US1: Wizard-bootstrapped clusters keep `gh` working indefinitely (Priority: P1)

**As a** Generacy operator running a wizard-bootstrapped cluster (no `github-app` descriptor),
**I want** the orchestrator and workers to obtain fresh GitHub tokens on demand from the control-plane,
**So that** `gh` calls (label sync, label monitor, PR feedback monitor, webhook setup, worker actions) keep working for the full lifetime of the cluster instead of failing with 401 once the wizard's seeded `GH_TOKEN` expires (~1h after activation).

**Acceptance Criteria**:
- [ ] After deploying the fix to a wizard-bootstrapped cluster (with no `github-app` entry in `.agency/credentials.yaml`), the JIT gh provider is constructed at orchestrator startup.
- [ ] The provider calls `JitGitTokenClient.fetch()` with no `credentialId` argument when no `github-app` descriptor exists.
- [ ] All `gh` callers (`LabelMonitorService`, `PrFeedbackMonitorService`, `LabelSyncService`, `WebhookSetupService`, `ClaudeCliWorker` workers) receive a fresh token via the provider and do not fall through to the ambient `GH_TOKEN`.
- [ ] A cluster that has been running for >2h with no manual credential refresh continues to perform `gh` operations without 401 errors.

### US2: Clusters with a `github-app` descriptor keep working exactly as today (Priority: P1)

**As a** Generacy operator running a cluster that *does* have a `github-app` credential descriptor (cloud-managed or future bootstrap modes),
**I want** the existing behavior to be preserved bit-for-bit,
**So that** the fix does not regress descriptor-based clusters that already work correctly under #773.

**Acceptance Criteria**:
- [ ] When `initialDescriptors` contains a `github-app` entry, the provider is constructed with `credentialId = ghapp.credentialId` and `fetch(credentialId)` is called with that descriptor's id (existing behavior).
- [ ] `authHealth.recordResult(credentialId, ...)` continues to key by the real `credentialId` when a descriptor exists, so the existing `cluster.credentials` `refresh-requested`/`auth-failed`/`auth-recovered` flow keeps working unchanged for descriptor-based clusters.

### US3: Observable failures when the control-plane `/git-token` endpoint is unreachable (Priority: P2)

**As a** Generacy operator,
**I want** clear, observable failures when the JIT provider cannot reach the control-plane (instead of a silent fallback to a static expired token),
**So that** I can act on real failures rather than chase mysterious 401s an hour after activation.

**Acceptance Criteria**:
- [ ] When `POST /git-token` is unreachable from a wizard-bootstrapped cluster, the provider throws `JitTokenError('CONTROL_SOCKET_UNREACHABLE')` (same code path as today's descriptor-present case).
- [ ] The failure is logged once at `warn` level with the synthetic cache key (e.g. `'default'`) and surfaced to the `GitHubAuthHealthService` so existing `auth-failed` relay events fire.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `createJitGithubTokenProvider`'s `credentialId` option MUST be optional. When omitted, the provider MUST call `client.fetch()` with no argument (i.e. credential-less). | P1 | Mirrors `git-credential-generacy` precedent already shipped. |
| FR-002 | `server.ts` MUST build the JIT gh provider whenever `createJitGitTokenClient` can be constructed (the control-plane socket precondition), regardless of whether a `github-app` descriptor is present in `.agency/credentials.yaml`. | P1 | Removes the `githubAppCredentialId ? … : undefined` ternary gate. |
| FR-003 | When no `github-app` descriptor exists, the provider's internal cache key and `authHealth.recordResult(...)` keying MUST use a stable synthetic constant (e.g. `'default'`). When a descriptor *does* exist, both MUST continue to use the real `credentialId`. | P1 | Keeps `GitHubAuthHealthService` snapshots coherent without inventing fake descriptors. |
| FR-004 | The same provider MUST be threaded to `ClaudeCliWorker` (worker mode) via the existing `tokenProvider` plumbing, so worker-mode `gh` calls also benefit. | P1 | Worker has the same gating today; one change fixes both. |
| FR-005 | When a `github-app` descriptor *is* present, the provider's call signature MUST be unchanged from #773 (`fetch(credentialId)`), and observable side-effects (cache key, auth-health key, log fields) MUST be identical to current behavior. | P1 | Strict no-regression for descriptor-based clusters. |
| FR-006 | The new code path MUST be exercised by a regression test that constructs the provider with no `credentialId`, stubs `JitGitTokenClient.fetch`, and asserts `fetch` is called with no argument and the returned token is cached + returned. | P1 | Locks in the wizard-cluster path. |
| FR-007 | Existing failure semantics (`JitTokenError`, `authHealth` notification, cache eviction on failure) MUST apply to the credential-less path. | P2 | Failure paths re-used as-is. |
| FR-008 | The change MUST NOT add any read of `GH_TOKEN` from `/var/lib/generacy/wizard-credentials.env` for `gh` purposes; the ambient env var stays only as the legacy fallback that the fix is eliminating. | P2 | Guards against accidentally re-introducing the original bug surface. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Wizard-bootstrapped production cluster `gh` 401 rate | 0 over a 24h window after deploy | Inspect orchestrator logs (`label-monitor-service`, `pr-feedback-monitor-service`, `label-sync-service`, `webhook-setup-service`) for `Bad credentials` / `HTTP 401` lines following deploy of the fix on `ai-lawfirm` (or equivalent prod cluster). |
| SC-002 | JIT provider construction on wizard cluster | Provider is non-null at orchestrator startup with no `github-app` descriptor | New unit test in `tests/unit/services/jit-github-token-provider.test.ts` covering the credential-less path; orchestrator startup log line `JIT GitHub token provider constructed (credential-less)` (or equivalent) observed in cluster startup. |
| SC-003 | No regression for descriptor-based clusters | All existing `jit-github-token-provider.test.ts` and `label-monitor-service.401.test.ts` cases pass without modification of expected `fetch(credentialId)` argument. | `pnpm -F @generacy-ai/orchestrator test` green; diff review confirms no existing test's expected arguments were loosened. |
| SC-004 | Time-to-first-failure on a fresh wizard cluster | >24h (i.e. unbounded by the 1h ambient token) | Manual smoke on a fresh wizard-bootstrapped cluster: leave it idle/active for >24h after activation; verify `gh` operations still succeed. Pre-fix baseline: ~1h. |

## Assumptions

- The control-plane `POST /git-token` endpoint accepts an empty JSON body `{}` and resolves the GitHub App installation server-side from the cluster API key. (Verified in `packages/control-plane/src/services/jit-git-token-client.ts:90-91` and proven in production by `git-credential-generacy`.)
- All wizard-bootstrapped production clusters reachable today have a valid cluster API key at `/var/lib/generacy/cluster-api-key` and can reach the cloud's pull endpoint (i.e. the same precondition that makes `git clone` work today).
- The `GitHubAuthHealthService` is tolerant of a synthetic credential id (`'default'`) as a key — it does not validate the key against `.agency/credentials.yaml`. (To be re-verified during /clarify or /plan.)
- Worker-mode `ClaudeCliWorker` shares the same provider instance as orchestrator-mode (or constructs an equivalent one with identical semantics) so a single fix covers both.

## Out of Scope

- Adding a `github-app` credential descriptor synthesis step to the wizard bootstrap (orthogonal — and explicitly out of scope per the issue's "credential-less" framing).
- Cloud-side changes to `POST /git-token` (the endpoint already supports credential-less mode).
- Refactoring `GitHubAuthHealthService` to model "no descriptor" as a distinct status (out of scope — the synthetic key reuses the existing per-credential state machine).
- Changes to `wizard-env-writer.ts` / `wizard-credentials.env` — the file remains as-is for non-`gh` consumers (e.g. legacy bash scripts in cluster-base entrypoint).
- Telemetry/logging changes beyond what is strictly needed to make the credential-less path observable.
- Multi-installation / multi-org `github-app` scenarios — single-installation only, matching today's behavior.

## Related

- **#773** — introduced the JIT provider with the over-restrictive `github-app` descriptor gate. The rest of #773 (JIT client, caching, fail-loud, dual-socket forwarding) is correct and stays.
- **#762** — cluster-side GH_TOKEN expiry detection / `GitHubAuthHealthService`. The `refresh-requested` warnings firing in production are what surfaced this regression — the backstop is working as designed.
- **#766** — cluster-side JIT git credential helper. Establishes the credential-less precedent for the git path that this fix mirrors for the `gh` path.
- **#768** — worker-side git-token proxy bin. Same `/git-token` route is reused; no proxy changes needed.

---

*Generated by speckit*
