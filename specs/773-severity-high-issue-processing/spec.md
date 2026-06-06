# Feature Specification: ## Severity

**High

**Branch**: `773-severity-high-issue-processing` | **Date**: 2026-06-05 | **Status**: Draft

## Summary

## Severity

**High.** Issue processing works for ~1 hour after activation, then **every GitHub API call 401s** and all workers fail. The JIT git-credential work (#766/#817/#819) fixed `git` auth but missed the `gh` CLI path, which is the **majority** of GitHub interactions (reading issues, posting stage comments, managing labels, creating/updating PRs, repo metadata).

## Symptom (verified live, prod cluster)

After ~1h, workers fail with:
```
GhAuthError: gh authentication failed (HTTP 401): Bad credentials
  at GhCliGitHubClient.executeGh (.../workflow-engine/.../gh-cli.js)
  at GhCliGitHubClient.getIssue / getIssueComments / repo view
```
…and the orchestrator's #762 backstop logs `GitHub authentication failing — investigate credential refresh chain`. On the same worker at the same time, **`git clone` succeeds** (JIT helper) while **`gh api` 401s** (static token). The worker's `GH_TOKEN` (`ghs_…`) returns `Bad credentials` — it's the expired 1-hour installation token.

## Root cause

Two GitHub auth paths; only `git` was migrated to JIT:

| Path | Token source | Status |
|---|---|---|
| `git` clone/push | JIT credential helper (`git-credential-generacy` → control-plane `/git-token` → cloud pull) | ✅ fresh per op |
| `gh` CLI — **all GitHub API** | static `GH_TOKEN` from `wizard-credentials.env` | ❌ 401 after ~1h |

`gh` does not consult git credential helpers — it authenticates from `GH_TOKEN`/`gh auth`. The orchestrator wires the **static** provider for every GitHub-API client:

- `server.ts:161` — `createWizardCredsTokenProvider('/var/lib/generacy/wizard-credentials.env', …)` reads the static `GH_TOKEN` (the wizard-delivered 1-hour installation token; `wizard-creds-token-provider.ts` only re-reads the file, never re-mints).
- `server.ts:298` — `new ClaudeCliWorker(…, { tokenProvider: wizardCredsTokenProvider })`. This callsite is inside `if (isWorkerMode)` (server.ts:263) so it runs in the **worker process** — this is the path that produced the 401s in the original report (`WorkerDispatcher.runWorker → ClaudeCliWorker.handle → GhCliGitHubClient.getIssue`).
- `server.ts:207` — `LabelSyncService(…, wizardCredsTokenProvider)`; plus the label monitor and PR-feedback handler use the same. These three run in the **orchestrator process**.

So the bulk of the workflow's GitHub traffic rides a token that dies after an hour — exactly the 1-hour-expiry failure the JIT work was meant to eliminate.

## Fix

Replace `createWizardCredsTokenProvider` with a **JIT token provider** for the gh-CLI clients: fetch a fresh installation token on demand via the control-plane `/git-token` endpoint (the same path the git credential helper uses — `#819` already serves it; `cloud-pull-client.ts` already implements the call), with a short in-process cache + pre-expiry refresh. Wire it into the worker `ClaudeCliWorker` GitHub client, label monitor, label sync, and PR-feedback handler (the `tokenProvider` these pass to `executeGh` sets `GH_TOKEN` for the `gh` subprocess, so a fresh value per call = fresh `gh` auth).

- **Workers** (`ClaudeCliWorker` at server.ts:298, inside `if (isWorkerMode)`) reach the token endpoint through the **proxy socket** (`/run/generacy-git-token/control.sock` — env `GIT_TOKEN_SOCKET_PATH`); the **orchestrator** (label monitor, label sync, PR feedback) via the control-plane socket directly (`/run/generacy-control-plane/control.sock` — env `CONTROL_PLANE_SOCKET_PATH`). Same socket resolution `git-credential-generacy` already does — factor it out and reuse.
- **Shared socket client** lives in `packages/control-plane` (the package that owns `/git-token`): a `JitGitTokenClient` (request/response/error contract — the thing that drifts when `/git-token` evolves) imported by both `git-credential-generacy` and the new orchestrator/worker provider. The **in-process cache** lives in the orchestrator/worker-side wrapper, not in the shared client — `git-credential-generacy` is a short-lived CLI that mints once and exits, so caching there is pointless. (Clarification Q2.)
- **Failure semantics**: when the provider cannot resolve a fresh token (socket unreachable, `/git-token` 4xx/5xx, malformed response), it throws a typed `JitTokenError` (`gh` is never invoked, no 401 round-trip) **and** records `{ ok: false, statusCode: 503 }` to `AuthHealthSink` so the #762 backstop's `auth-failed`/`refresh-requested` flow fires immediately. Never return `undefined` — that falls back to ambient `GH_TOKEN` (the expired static token) and silently reproduces the bug. (Clarification Q3.)
- **Static-provider retirement**: once all callsites move to the JIT provider, delete `wizard-creds-token-provider.ts` and its tests in this PR. Leave `wizard-env-writer.ts` emitting `GH_TOKEN` to `wizard-credentials.env` — other paths (shell-level `gh`, setup scripts) may still read the ambient env, and `executeGh` overrides `GH_TOKEN` from the provider anyway, so the lingering env line is harmless. Retiring it deserves its own audit and belongs in a follow-up issue. (Clarification Q1.)
- No cloud or cluster-base change needed — the `/git-token` endpoint and proxy already exist.

## Acceptance criteria

- [ ] All gh-CLI GitHub API calls (`ClaudeCliWorker` in the worker process; label monitor, label sync, PR-feedback handler in the orchestrator process) obtain fresh installation tokens via the JIT path — not the static `wizard-credentials.env` `GH_TOKEN`.
- [ ] A cluster processes issues continuously for **many hours** with zero `gh` 401s and no manual credential refresh.
- [ ] Both orchestrator and worker gh paths are covered. Provider auto-resolves the correct socket per container: workers via `GIT_TOKEN_SOCKET_PATH` (default `/run/generacy-git-token/control.sock`), orchestrator via `CONTROL_PLANE_SOCKET_PATH` (default `/run/generacy-control-plane/control.sock`).
- [ ] Shared `JitGitTokenClient` lives in `packages/control-plane` and is imported by both `git-credential-generacy` and the orchestrator/worker provider. The in-process cache is owned by the orchestrator/worker wrapper only.
- [ ] When `/git-token` is unreachable, the provider throws a typed `JitTokenError` and reports `{ ok: false, statusCode: 503 }` to `AuthHealthSink` so the #762 backstop fires immediately. The provider never returns `undefined`.
- [ ] `wizard-creds-token-provider.ts` and its tests are deleted; the four wiring sites (`server.ts:161`, `server.ts:207`, `server.ts:298`, plus the label monitor / PR-feedback handler factories) no longer reference it. `wizard-env-writer.ts` still emits `GH_TOKEN` to `wizard-credentials.env` (retirement of that line is a follow-up).

## Related

- Completes the JIT migration started in #766 / generacy-ai/generacy-cloud#817 / #819 (which covered only `git`).
- The #762 cluster-side backstop is what surfaces this (the loud `investigate credential refresh chain` warning) — working as designed.
- Once this lands, the static `GH_TOKEN` in `wizard-credentials.env` is no longer the source of truth for gh auth (it can remain for any non-gh use, or be retired separately).

## Clarifications

Decisions captured in `clarifications.md` (Batch 1, 2026-06-05). Full context + options preserved there; summary below.

- **Q1 — wizard-creds retirement scope (B):** delete `wizard-creds-token-provider.ts` and its tests in this PR; keep `wizard-env-writer.ts` emitting `GH_TOKEN` (retiring the env line is a separate audit/follow-up).
- **Q2 — JIT provider location (B):** shared `JitGitTokenClient` in `packages/control-plane` (the package that owns `/git-token`), imported by both `git-credential-generacy` and the new orchestrator/worker provider. Caching lives in the orchestrator/worker wrapper, not the shared client.
- **Q3 — failure-mode semantics (B):** provider throws a typed `JitTokenError` AND reports `{ ok: false, statusCode: 503 }` to `AuthHealthSink` so the #762 backstop's `auth-failed`/`refresh-requested` flow fires without waiting for a `gh` 401. Never return `undefined` (would silently revert to the expired static `GH_TOKEN`).
- **Q4 — provider scope vs FR-002 worker-socket clause (B, dual-mode) — with premise correction:** the earlier framing that all four wiring sites are orchestrator-process and worker gh is out-of-scope was **wrong**. `server.ts:298` (`ClaudeCliWorker`) is inside `if (isWorkerMode)` and runs in the **worker process** — it is the path that produced the original 401s. The provider must resolve **both** sockets: workers via `/run/generacy-git-token/control.sock` (proxy), orchestrator via `/run/generacy-control-plane/control.sock` (direct). Detect via env vars (`GIT_TOKEN_SOCKET_PATH` / `CONTROL_PLANE_SOCKET_PATH`), same resolution `git-credential-generacy` already does.

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
