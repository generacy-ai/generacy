# Feature Specification: ## Severity

**High — #773 does not actually fix the reported failure on real clusters

**Branch**: `777-severity-high-773-not` | **Date**: 2026-06-06 | **Status**: Draft

## Summary

## Severity

**High — #773 does not actually fix the reported failure on real clusters.** The JIT gh-token provider is gated on a `github-app` credential descriptor that wizard-bootstrapped clusters (all current clusters) never have, so the provider is always `undefined` and every `gh` call falls back to the ambient `GH_TOKEN` — the same static 1-hour token #773 was meant to retire. Processing works for ~1h after activation, then all `gh` calls 401 again (label sync, monitor, PR feedback, workers).

## Evidence (live prod cluster, ai-lawfirm, after #773 deploy)

- #773 **is** deployed: `services/jit-github-token-provider.js` present; `server.js` wires `JitGitTokenClient`; no `wizardCredsTokenProvider` left.
- `POST /git-token` returns a **valid, working** token: `gh api repos/Painworth/ai-lawfirm` succeeds with it (expiry ~36 min out, cached/deduped correctly).
- Yet the orchestrator's own `gh` calls 401 with `Bad credentials`, using the **ambient `GH_TOKEN` (`ghs_l4ZJ…`)** — which I confirmed is the expired wizard token (`/var/lib/generacy/wizard-credentials.env` `GH_TOKEN` → 401).
- `git clone` over https **works** (helper bin calls `client.fetch()` credential-less).

## Root cause

`packages/orchestrator/src/server.ts`:
```ts
const initialDescriptors = await readCredentialDescriptors(agencyDir);
const ghapp = initialDescriptors.find(d => d.type === 'github-app');
githubAppCredentialId = ghapp?.credentialId;            // undefined on wizard clusters
…
const githubTokenProvider = githubAppCredentialId
  ? createJitGithubTokenProvider({ … credentialId: githubAppCredentialId … })
  : undefined;                                           // → callers fall through to ambient GH_TOKEN
```
Wizard-bootstrapped clusters carry only a raw GitHub token credential (`GH_TOKEN`/`GH_USERNAME`/`GH_EMAIL`), **no `github-app` descriptor**, so `githubAppCredentialId` is `undefined`, the provider is never created, and `GhCliGitHubClient.getEnv()` returns `undefined` → `gh` inherits the ambient (expired) `GH_TOKEN`.

The **git** path doesn't hit this because `git-credential-generacy` calls `client.fetch()` with no argument, and the JIT client already handles that:
```ts
// control-plane jit-git-token-client.js
async fetch(credentialId) {
  const body = credentialId === undefined ? '{}' : JSON.stringify({ credentialId });
  …
}
```
The control-plane resolves the installation server-side from the cluster-api-key — no descriptor needed. So the gh provider's dependency on a `github-app` `credentialId` is over-specification; the underlying `/git-token` path works credential-less (proven by the working git clone and a direct `{}` probe).

## Fix

Stop gating the gh JIT provider on a `github-app` descriptor. Build it whenever the control-plane `/git-token` path is available (cluster-api-key / cloud pull configured — the same precondition the git helper relies on), and call `fetch()` **credential-less** (pass `credentialId` only when a descriptor actually exists). Make `credentialId` optional in `createJitGithubTokenProvider`:

- Cache key + `authHealth.recordResult(...)` keying fall back to a reserved-prefix sentinel (`'__wizard__'`) when no descriptor is present (see Clarifications Q1).
- Both orchestrator and worker modes (worker `ClaudeCliWorker` builds its own provider with an independent cache — see Clarifications Q4).

## Clarifications

Resolved decisions from clarification batch 1 (see [clarifications.md](clarifications.md) for full rationale):

- **Synthetic key (Q1)**: Use a reserved-prefix sentinel (`'__wizard__'`) — *not* `'default'` — for both the cache key and `authHealth.recordResult(...)` keying when no `github-app` descriptor exists. Self-documenting in logs/relay payloads; cannot collide with real installation/credential ids; trivial for future cloud consumers to recognize-and-ignore.
- **Construction precondition (Q2)**: Gate provider construction on the presence of `/var/lib/generacy/cluster-api-key` — *not* a control-plane socket probe and *not* unconditional. This matches the precondition `git-credential-generacy` already relies on, distinguishes a cloud-connected wizard cluster (build provider) from a genuinely unconfigured/offline cluster (keep ambient fallback), and avoids the startup-race class where the socket binds after descriptors are resolved.
- **Cloud-side compatibility (Q3)**: No cloud-side change required. generacy-cloud currently has no consumer for `refresh-requested`/`auth-failed` events (#762 cloud handler deferred); they are fire-and-forget telemetry. The credential-less path does not depend on cloud push-refresh — JIT re-fetches inline via `/git-token`, which resolves the installation server-side from cluster identity (not from `credentialId`). Continue emitting events with the synthetic id.
- **Worker mode (Q4)**: Each worker process constructs its own credential-less `createJitGithubTokenProvider` at startup with an independent cache. Providers are closures over a client + `Map` and cannot cross a process boundary, so cross-process sharing is impossible. Worker mode is **in scope** — workers are the primary failure surface for the reported breakage.
- **Fail-loud behavior (Q5)**: When the JIT provider throws `JitTokenError`, callers (label monitor, PR-feedback monitor, worker) catch at the loop boundary, log, and **skip the `gh` call** for that cycle. The throw must never silently fall through to spawning `gh` with the ambient/expired `GH_TOKEN`. As defense-in-depth, when the provider is present, set `GH_TOKEN: ''` in the `gh` env override so the ambient value cannot leak through an unforeseen caller path. `AuthHealthSink.recordResult({ ok: false, statusCode: 503 })` supplies the observable signal.

## Acceptance criteria

- [ ] A wizard-bootstrapped cluster (no `github-app` descriptor) builds the JIT gh provider and refreshes `gh` tokens via `/git-token`.
- [ ] Such a cluster runs **many hours** with zero `gh` 401s and no ambient-token fallback.
- [ ] Regression test: provider is created and fetches credential-less when `initialDescriptors` contains no `github-app` entry, and the api-key file exists.
- [ ] Negative test: when `/var/lib/generacy/cluster-api-key` is *absent* (truly unconfigured/offline cluster), the provider is NOT created and the legacy fallback path applies.
- [ ] When a `github-app` descriptor *does* exist, behavior is unchanged (credentialId still passed; sentinel not used).
- [ ] Cache key and `authHealth` keying use the reserved-prefix sentinel (`'__wizard__'`) consistently in the credential-less path.
- [ ] `gh` callers that hit `JitTokenError` log, skip the call, and do NOT spawn `gh` with the ambient `GH_TOKEN`.
- [ ] When the provider is present, the `gh` env override explicitly sets `GH_TOKEN` (to the fresh value, or `''` on the throw-and-skip path) so ambient leakage is impossible.
- [ ] Worker processes build their own credential-less provider at worker startup with identical fail-loud behavior to the orchestrator.

## Related

- Caused by the gating introduced in #773 (the rest of that PR — JIT client, caching, fail-loud, dual-socket — is correct and working).
- Mirrors the credential-less precedent already shipped for `git-credential-generacy`.
- #762 backstop is what surfaced it (the `investigate credential refresh chain` warnings are firing as designed).

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
