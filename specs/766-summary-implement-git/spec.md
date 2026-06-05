# Feature Specification: Cluster-side JIT git credential helper

**Branch**: `766-summary-implement-git` | **Date**: 2026-06-05 | **Status**: Draft
**Issue**: [generacy-ai/generacy#766](https://github.com/generacy-ai/generacy/issues/766)

## Summary

Implement a git `credential.helper` on the cluster that, **on each git operation**, returns a fresh GitHub installation token obtained on demand (via the cloud's new pull endpoint — generacy-ai/generacy-cloud#817), with a short in-memory cache + pre-expiry refresh. This replaces the cluster's reliance on the static `GH_TOKEN` in `wizard-credentials.env`. This is the **consume side** of the durable git-auth fix.

## Why

Installation tokens are capped at 1h by GitHub and can't be extended, so the only robust design is **fetch-on-use**: never hold a long-lived token; obtain a fresh one at the moment git needs it. Today the cluster caches a static token and depends on a fragile cloud *push* to refresh it before expiry — when that push fails, the cluster goes dark ~1h after activation (the #762 backstop now detects this loudly, but the token still isn't refreshed).

**Why this kills the mid-workflow-expiry risk:** every `clone`/`fetch`/`push` gets a token fresh *at the instant it runs*, and a single git op completes in seconds-to-minutes — far inside the hour. A phase that clones at the start and pushes at the end gets a fresh token at each step. Mid-workflow expiry becomes **structurally impossible**, not merely recoverable.

## Scope (this repo)

- A git credential helper hosted by `packages/control-plane` (the long-lived in-cluster process that already owns the cluster API key and mediates credentials), exposed as `POST /git-token` on the control socket and fronted by a thin git-credential CLI wrapper that git invokes per request. The helper:
  - Speaks the git credential-helper protocol for `github.com`.
  - On `get`, calls control-plane over the existing Unix socket; control-plane returns a fresh installation token from the cloud pull endpoint (#817), caching briefly in-daemon and refreshing within ~5 min of expiry.
  - Is callable by both the orchestrator and worker git operations.
- Stop treating the static `wizard-credentials.env` `GH_TOKEN` as the source of truth for **git** auth (it can remain for non-git uses if needed, but git should pull JIT).

## User Stories

### US1: Long-running worker performs git ops without auth failures

**As a** Generacy cluster operator running multi-hour agent workflows,
**I want** every `git clone`/`fetch`/`push` issued by orchestrator and workers to silently obtain a fresh installation token at the moment of the operation,
**So that** workflows that span longer than GitHub's 1h installation-token TTL never fail mid-stream with `HTTP 401: Bad credentials` and never require a manual cluster restart to recover.

**Acceptance Criteria**:
- [ ] A worker session running for 4+ hours that performs `git clone`, periodic `git fetch`, and final `git push` succeeds at every step without any token-refresh push from the cloud during the run.
- [ ] No static long-lived `GH_TOKEN` for git appears in `~/.git-credentials`, `~/.netrc`, or any env file consumed by git.
- [ ] If the cloud pull endpoint is unreachable when a git op fires, the operator sees a distinct, actionable error (not a silent hang or a generic "fatal: Authentication failed").

### US2: Helper short-circuits redundant cloud calls within a token's lifetime

**As a** cluster operator running short bursty workflows (many git ops within minutes),
**I want** the helper to cache a fetched token in memory and reuse it until shortly before its expiry,
**So that** typical sessions don't generate a cloud round-trip per `git` invocation and the cloud endpoint isn't hit redundantly.

**Acceptance Criteria**:
- [ ] Within a token's lifetime, the helper serves git from in-memory cache without re-calling the cloud pull endpoint.
- [ ] When the cached token is within the pre-expiry window (~5 min), the next `get` triggers a refresh.
- [ ] On a cold start (no cached token), the helper fetches synchronously and returns the result to git.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Implement a git credential helper that speaks the git credential-helper line protocol (`get`/`store`/`erase`) for `github.com`. | P1 | `store`/`erase` may be no-ops; `get` is the load-bearing path. Implemented as a thin CLI wrapper that talks to control-plane over its Unix socket. |
| FR-002 | On `get`, return a fresh installation token from the cloud pull endpoint (generacy-ai/generacy-cloud#817), routed via control-plane's new `POST /git-token` socket endpoint. | P1 | Home: `packages/control-plane` — long-lived process that already owns the cluster API key and credentials mediation. |
| FR-003 | Cache the fetched token in memory inside the control-plane process and serve subsequent `get` calls from cache while the token is still within its valid window. | P1 | Cache scope: control-plane process (single long-lived daemon); bounded by `expiresAt` from cloud. Per-invocation CLI wrapper holds no state. |
| FR-004 | When the cached token is within ~5 minutes of `expiresAt`, the next `get` refreshes synchronously (no background timer in v1). | P1 | Pure synchronous-on-demand refresh — every git op is always handed a valid token; no idle minting while the cluster is quiet. Background warmer deferred unless latency/observability later demands it. |
| FR-005 | The helper is callable from both orchestrator and worker contexts. | P1 | Worker contexts use credhelper session env; orchestrator uses its in-process path or socket. The CLI wrapper resolves the control-plane socket path via `CONTROL_PLANE_SOCKET_PATH` env var (default `/run/generacy-control-plane/control.sock`). |
| FR-006 | Configure `git credential.helper` cluster-side (companion cluster-base PR generacy-ai/cluster-base#61) so that all git invocations route through the helper for `github.com`. | P1 | Includes ensuring `~/.git-credentials` does not contain a competing static token. |
| FR-007 | Stop seeding `GH_TOKEN` from `wizard-credentials.env` into git's credential surface (`~/.git-credentials`/`~/.netrc`). | P1 | The env var may remain for non-git uses (e.g., `gh` CLI in monitors), but must not be the source of truth for git. |
| FR-008 | When the cloud pull fails (network, 4xx, 5xx), the helper exits with a distinct error and stderr message; git surfaces a clean failure rather than hanging. | P1 | Match the failure-loudness ethos from #762. |
| FR-009 | Control-plane rate-limits / debounces concurrent `get` calls so that N simultaneous git ops collapse to a single cloud fetch. | P2 | Dedup state lives in the long-lived daemon (not per-invocation wrapper). Avoid thundering herd when many workers start at once. |
| FR-010 | Telemetry: control-plane emits structured log lines per `get` (cache hit / miss / refresh / error) and per cloud-pull attempt. | P2 | Useful for diagnosing future regressions; aligns with existing structured-log style. |
| FR-011 | Control-plane authenticates to the cloud pull endpoint (#817) using the cluster API key persisted at `/var/lib/generacy/cluster-api-key` (same credential the relay handshake uses). | P1 | Helper is unavailable until activation completes — acceptable because git auth isn't needed pre-activation. Cloud-side (#817) must accept this credential. |
| FR-012 | Helper's `get` response uses constant sentinel `username=x-access-token` with the installation token in the `password` line. | P1 | Matches GitHub's HTTPS pattern for installation tokens and the existing `x-access-token` URL convention in `packages/control-plane/src/services/peer-repo-cloner.ts:25`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Long-running session git-auth durability | 0 auth failures over a 4+ hour worker session performing periodic git ops | Run a soak workflow with hourly git ops; verify no `HTTP 401`/auth-failure log lines. |
| SC-002 | No static git token on disk | 0 occurrences of long-lived installation tokens in `~/.git-credentials`, `~/.netrc`, or shell env files used by git | Grep cluster filesystem after activation + post-bootstrap; configured `credential.helper` is the only source. |
| SC-003 | Cache effectiveness for bursty sessions | ≥ 95% of `get` calls within a single token lifetime served from cache | Control-plane telemetry: ratio of cache-hits to total `get` invocations. |
| SC-004 | Pre-expiry refresh hits before failure | 100% of token transitions occur via pre-expiry refresh, not post-expiry failure-and-retry | Control-plane telemetry: count of refreshes triggered with `expiresAt - now ≤ 5 min` vs refreshes triggered after a 401. |
| SC-005 | Clear failure when cloud pull is down | Test injection of cloud pull failure produces a distinct, non-generic error to the operator within seconds | Manual: block cloud endpoint, run `git fetch`, observe error surface (log/health). |
| SC-006 | Mid-workflow expiry eliminated | 0 instances of cluster going dark ~1h after activation across post-rollout cluster lifetimes | Compare incident rate before/after over a 2-week window. |

## Assumptions

- The cloud on-demand token endpoint (generacy-ai/generacy-cloud#817) is delivered before this consumer ships; helper failure-modes for endpoint absence are scoped to the loud-failure path (FR-008) rather than a fallback to the old static token.
- The cloud pull endpoint (#817) accepts the cluster API key (`/var/lib/generacy/cluster-api-key`) as its caller credential; coordination with the cloud team is required to ensure this surface is wired before consumer rollout.
- Installation tokens returned by the cloud carry an `expiresAt` (or equivalent) suitable for driving the pre-expiry refresh window.
- The control-plane process is reachable from every context that runs git on the cluster (orchestrator, worker shells, agent subprocesses) via its Unix socket.
- All cluster git operations target `github.com`; non-github git remotes are out of scope for the helper's matching rule.
- The cluster-base companion PR (generacy-ai/cluster-base#61) is responsible for wiring `git config --global credential.https://github.com.helper` to point at the new CLI wrapper.
- Pre-activation git auth is not required; the helper returning an error before `/var/lib/generacy/cluster-api-key` exists is acceptable.

## Out of Scope

- The cloud-side pull endpoint itself (lives in generacy-ai/generacy-cloud#817).
- Refresh-via-push from the cloud (this feature is the **replacement** for that model; #813's push path is not removed in this issue but is no longer load-bearing for git).
- Auth failures detection/observability for non-git GitHub API callers (the `gh` CLI monitors); those continue to use the #762 backstop pattern.
- Credentials other than GitHub installation tokens (PATs, OAuth user tokens, non-GitHub remotes).
- Removing the static `GH_TOKEN` env var altogether — it may remain for non-git uses (e.g., `gh` CLI in orchestrator monitors); only its role as the git source-of-truth is removed.
- The cluster-base configuration changes (companion PR generacy-ai/cluster-base#61; this spec assumes they land in tandem).
- A background pre-expiry warmer/timer (deferred — pure synchronous-on-demand refresh is sufficient for the v1 correctness target; revisit only if telemetry shows latency or observability gaps).

## Dependencies

- **Supply (blocking):** generacy-ai/generacy-cloud#817 — cloud on-demand installation-token pull endpoint (must accept the cluster API key as caller credential).
- **Wiring (companion):** generacy-ai/cluster-base#61 — configure `git credential.helper`, stop seeding static git creds into `~/.git-credentials`.
- **Predecessor (superseded for git):** generacy-ai/generacy-cloud#813 (push-refresh chain) and this repo's #762 (loud-failure backstop). #762 remains valuable for non-git GitHub API auth.

## Clarifications

### Batch 1 — 2026-06-05

- **Q1 (Helper Home Package) → A:** Logic lives in `packages/control-plane`, exposed as `POST /git-token` on the control socket; a thin git-credential CLI wrapper is what git actually invokes. Control-plane already owns the cloud/relay connection and the cluster API key and is the cluster's existing credential mediator; lowest-coupling home.
- **Q2 (Cache Process Model) → A:** In-memory cache + concurrent-`get` collapsing live inside the long-lived control-plane process. The CLI wrapper is a stateless socket client (git spawns it per request, so it can't hold cross-`get` state).
- **Q3 (Cloud Pull Endpoint Authentication) → A:** Reuse the cluster API key at `/var/lib/generacy/cluster-api-key` (same credential the relay handshake uses). Helper is unavailable until activation completes — acceptable, since git auth isn't needed pre-activation. Cloud must accept this credential on #817.
- **Q4 (Pre-Expiry Refresh Trigger) → A:** Synchronous-on-demand only — the next `get` after the pre-expiry window opens performs the fresh fetch. No background timer in v1; every git op is always handed a valid token, and there's no idle minting while the cluster is quiet. Background warmer deferred unless future telemetry demands it.
- **Q5 (Git Credential Response Username) → A:** Constant `x-access-token` (GitHub-standard sentinel for installation tokens, matches the existing pattern in `packages/control-plane/src/services/peer-repo-cloner.ts:25`).

---

*Generated by speckit*
