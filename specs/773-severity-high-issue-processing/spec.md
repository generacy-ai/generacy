# Feature Specification: JIT gh-CLI token provider — eliminate static `GH_TOKEN` for GitHub API

**Branch**: `773-severity-high-issue-processing` | **Date**: 2026-06-05 | **Status**: Draft | **Issue**: [#773](https://github.com/generacy-ai/generacy/issues/773)

## Summary

Complete the JIT (just-in-time) credential migration started in #766 / generacy-cloud#817 / #819 by routing **every `gh` CLI call** through a freshly-minted installation token instead of the static `GH_TOKEN` read from `wizard-credentials.env`. Today, `git` operations succeed (JIT helper) while `gh` API calls 401 after ~1 hour because the wizard-delivered installation token expires and is never re-minted. Workers stall, the orchestrator's #762 backstop emits `GitHub authentication failing — investigate credential refresh chain`, and issue processing halts until manual intervention.

The fix: introduce a JIT `tokenProvider` that fetches a fresh installation token on demand via the existing control-plane `POST /git-token` endpoint (control-plane socket for the orchestrator, proxy socket for workers — the same resolution the `git-credential-generacy` bin already does), with a short in-process cache. Wire it into the four gh-CLI consumers (worker GitHub client, label monitor, label sync service, PR-feedback handler) in place of `createWizardCredsTokenProvider`.

## User Stories

### US1: Continuous issue processing without manual credential refresh

**As a** Generacy operator running a cluster on a long-lived project,
**I want** the cluster's GitHub API traffic (issue reads, label updates, PR creation, stage comments) to keep working indefinitely after activation,
**So that** I do not need to babysit a credential refresh chain or restart workers every hour.

**Acceptance Criteria**:
- [ ] A cluster that has been running for >1 hour continues to read issues, post stage comments, manage labels, and create/update PRs via `gh` with **zero 401s**.
- [ ] The orchestrator's #762 `auth-failed` / `investigate credential refresh chain` log does NOT fire under normal operation.
- [ ] No operator action (restart, re-bootstrap, manual token paste) is required for multi-hour or multi-day cluster uptime.

### US2: Single source of truth for GitHub auth

**As a** Generacy engineer debugging an auth incident,
**I want** every cluster-side GitHub interaction (both `git` and `gh`) to mint tokens through the same JIT path (`/git-token` → cloud pull),
**So that** when auth fails, there is exactly one chain to investigate and one place to add observability.

**Acceptance Criteria**:
- [ ] `gh` API calls and `git` operations share the same token source (control-plane `/git-token`).
- [ ] The static `GH_TOKEN` from `wizard-credentials.env` is no longer read by any gh-CLI client wiring.
- [ ] Existing structured logs (`event: git-token-get`, `event: git-token-cloud-pull`) cover the gh-CLI traffic too — no new chain to monitor.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Introduce a JIT token provider (`createJitGitHubTokenProvider` or similar) that returns a fresh installation token from the control-plane `/git-token` endpoint. | P1 | Replaces `createWizardCredsTokenProvider` for gh-CLI consumers. |
| FR-002 | The provider MUST resolve the correct upstream socket based on container context: orchestrator → control-plane socket (`/run/generacy-control-plane/control.sock`); workers → proxy socket (`/run/generacy-git-token/control.sock`). | P1 | Factor out / reuse the resolution already present in `git-credential-generacy` bin. |
| FR-003 | The provider MUST cache the token in-process and serve from cache while `expiresAt - now > 5 min`, then refresh synchronously on the next call. | P1 | Match `GitTokenManager` semantics (#766). |
| FR-004 | Concurrent callers MUST share a single in-flight refresh Promise (no thundering herd against the upstream socket). | P1 | Match `GitTokenManager` semantics (#766). |
| FR-005 | Wire the JIT provider into `ClaudeCliWorker` (`server.ts:298`) in place of `wizardCredsTokenProvider`. | P1 | Worker GitHub-client path. |
| FR-006 | Wire the JIT provider into `LabelMonitorService` constructor in place of `wizardCredsTokenProvider`. | P1 | Orchestrator label-monitor poll path. |
| FR-007 | Wire the JIT provider into `LabelSyncService` (`server.ts:207`) in place of `wizardCredsTokenProvider`. | P1 | Orchestrator label-sync path. |
| FR-008 | Wire the JIT provider into `PrFeedbackMonitorService` / `PrFeedbackHandler` in place of `wizardCredsTokenProvider`. | P1 | PR-feedback path. |
| FR-009 | On upstream failure (socket unreachable, 4xx/5xx from `/git-token`), the provider MUST surface a typed error that callers can distinguish from a successful resolution of `undefined`. | P2 | Avoid silent fallback to no-token. Callers already handle `GhAuthError`. |
| FR-010 | The provider MUST NOT log token values. Structured logs MUST follow the existing `git-token-*` event shape. | P1 | No regression on secret hygiene. |
| FR-011 | `createWizardCredsTokenProvider` MAY remain in the codebase if used by non-gh paths, but MUST NOT be wired into any gh-CLI client. | P2 | Clarification needed on whether it can be deleted entirely — see [NEEDS CLARIFICATION 1]. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `gh` 401 rate on a steady-state cluster | 0 per hour (after first successful token mint) | Cluster logs / orchestrator `auth-failed` events over a 24h window. |
| SC-002 | Continuous operating window without manual refresh | ≥ 24 hours (target ≥ 7 days) | Live cluster run on a real project; observe issue processing continues past the 1h installation-token boundary. |
| SC-003 | Zero references to `createWizardCredsTokenProvider` in gh-CLI client wiring | 0 occurrences in `server.ts` for gh-CLI consumers | grep / code review at PR time. |
| SC-004 | `/git-token` upstream call volume per worker | Roughly `(workflow GitHub-API calls) / (cache window minutes / refresh-window minutes)`; cache hit rate ≥ 90% in steady state | Structured logs on the control-plane socket. |
| SC-005 | Time from cloud installation-token rotation to next gh-CLI call using new token | ≤ refresh-window (5 min) + one in-flight gh call | Inject a token rotation, observe next gh call uses the rotated token. |

## Assumptions

- The control-plane `POST /git-token` endpoint (#766) and the worker-side proxy socket (#768) are deployed in every variant where issue processing runs. Clusters that pre-date these PRs are out of scope (they cannot work today either).
- The cloud `/installation-token` pull endpoint (generacy-cloud#817) is the single source of truth for fresh installation tokens; this work does NOT introduce a parallel token-minting path.
- A `tokenProvider` returning a fresh value per call is sufficient to refresh `gh` auth: `GhCliGitHubClient.executeGh` already passes the resolved value as `GH_TOKEN` in the `gh` subprocess env, so each invocation gets the current token.
- The 5-minute pre-expiry refresh window inherited from `GitTokenManager` (#766) is acceptable for gh-CLI traffic. (No evidence today that gh-CLI needs a different window than `git`.)
- The default `github-app` credential ID resolution that #766 / #762 already perform at orchestrator startup is reusable; no new credential-selection logic is required.
- Per-credential multi-token support is **not** required for v1 (single-credential cache is sufficient — same scope as #766).

## Out of Scope

- Retiring the static `GH_TOKEN` from `wizard-credentials.env` for **non-gh** consumers (anything outside the four wiring sites listed in FR-005–FR-008). That is a follow-up cleanup.
- Cloud-side changes — no modification to the `/installation-token` endpoint or its callers in generacy-cloud.
- Cluster-base changes — `entrypoint-orchestrator.sh`, socket mounts, and proxy bin launch already exist (#768 / cluster-base#61).
- Adding new structured telemetry beyond what `GitTokenManager` already emits.
- Worker-process gh paths that already use credhelper session env (e.g., `pr-feedback-handler.ts` worker spawn) — those paths pass `undefined` for `tokenProvider` today and continue to do so per #620.
- Multi-credential token caching (the v1 cache key is a single credential ID; `Map<credentialId, ...>` upgrade is deferred unless a real second credential lands).
- Changes to the `GhCliGitHubClient` itself — the `tokenProvider` contract added in #620 is sufficient; only the wiring at construction sites changes.

## Clarifications

### Open questions

- **[NEEDS CLARIFICATION 1]** Should `createWizardCredsTokenProvider` and the `wizard-credentials.env` `GH_TOKEN` line be removed entirely once gh-CLI is migrated, or kept for any other consumer? (Issue body says "it can remain for any non-gh use, or be retired separately" — confirming retirement is out of scope here.)
- **[NEEDS CLARIFICATION 2]** Should the JIT provider live in `packages/orchestrator/src/services/` (alongside `wizard-creds-token-provider.ts`) or be exported from a shared package so the `git-credential-generacy` bin and the orchestrator share one implementation? The bin currently inlines its own socket-talking logic.
- **[NEEDS CLARIFICATION 3]** Failure-mode semantics when `/git-token` is unreachable mid-poll (e.g., control-plane restart): is a typed throw from the provider acceptable (callers see `GhAuthError`-shaped failure and the #762 backstop reports it), or should the provider expose a `getStatus()` for the existing `AuthHealthSink` to read independently of a call?

---

*Generated by speckit*
