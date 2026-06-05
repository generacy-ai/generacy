# Clarifications

## Batch 1 — 2026-06-05

### Q1: Helper Home Package
**Context**: The spec calls credhelper-daemon / control-plane the "natural home" but stops short of deciding. The choice determines which package owns the new logic, where the Unix socket lives, and how `cluster-base` wires `git config credential.helper`. It also affects which process holds the cache (Q2) and how `gh` CLI monitors interact (they already use `wizard-credentials.env`).
**Question**: Where does the new git credential-helper logic primarily live in this repo?
**Options**:
- A: New endpoint inside `packages/control-plane` (e.g., `POST /git-token` on the control socket) called by a thin git-credential CLI wrapper.
- B: New endpoint inside `packages/credhelper-daemon` (extends existing socket protocol / session model) called by a thin git-credential CLI wrapper.
- C: New standalone package (e.g., `packages/git-credhelper`) with its own long-lived daemon + CLI, separate from credhelper-daemon and control-plane.

**Answer**: **A** — control-plane endpoint + thin git-credential CLI wrapper. Control-plane already owns the cloud/relay connection and the cluster API key (see Q3), runs long-lived as uid 1000, and is the cluster's existing credential mediator (writes `wizard-credentials.env`, handles credential PUT/refresh). A `POST /git-token` on the existing control socket, fronted by a tiny CLI wrapper git invokes, is the lowest-coupling home. credhelper-daemon (B) is the uid-1002 ptrace-isolated local-secret server and doesn't own the cloud connection; a new standalone package (C) duplicates daemon + socket infra for no benefit.

### Q2: Cache Process Model
**Context**: Git invokes the configured `credential.helper` command per credential request. A per-invocation binary cannot hold an in-memory cache across `get` calls (process exits after each), so FR-003 + FR-009 only make sense behind a long-lived process. This decision interacts with Q1 but is independent (you can pick Q1=B with Q2=C, for example).
**Question**: Where does the in-memory token cache from FR-003 / FR-009 (concurrent-call collapsing) physically live?
**Options**:
- A: Inside an existing long-lived daemon (control-plane or credhelper-daemon, per Q1) — git invokes a tiny CLI wrapper that talks to the daemon over a Unix socket; cache and dedup live in the daemon.
- B: Inside a new long-lived helper-only daemon dedicated to git auth — git invokes a CLI wrapper that talks to this dedicated daemon.
- C: In the per-invocation helper binary itself, with no real cross-call cache (FR-003 collapses to whatever caching the cloud endpoint provides; FR-009 dedup becomes a no-op).

**Answer**: **A** — cache + dedup live in the long-lived control-plane daemon (per Q1). Git spawns the helper per credential request, so a per-invocation binary (C) can't hold a cross-`get` cache, which collapses FR-003 to whatever the cloud caches and reduces FR-009 dedup to a no-op. CLI wrapper stays a thin socket client. A dedicated new daemon (B) is redundant given the control-plane is already there.

### Q3: Cloud Pull Endpoint Authentication
**Context**: The helper must call generacy-cloud#817 to obtain a fresh installation token. The cluster already has two cloud-auth surfaces: the cluster API key written by `packages/orchestrator/src/activation/` to `/var/lib/generacy/cluster-api-key` (used by relay handshake), and per-session credhelper backends. The choice affects who can call the endpoint and how the helper degrades pre-activation.
**Question**: How does the in-cluster helper authenticate to the cloud pull endpoint (#817)?
**Options**:
- A: Reuses the cluster API key from `/var/lib/generacy/cluster-api-key` (same credential the relay uses for handshake; helper is unavailable until activation completes).
- B: Reuses an existing per-credential session/OIDC token issued through credhelper-daemon (scoped to the github-app credential entry in `.agency/credentials.yaml`).
- C: A new auth mechanism specified by #817 (e.g., signed cluster identity per request) — to be defined in the plan phase together with the cloud team.

**Answer**: **A** — reuse the cluster API key at `/var/lib/generacy/cluster-api-key`. It's the same credential the relay handshake already uses to identify the cluster to the cloud, the control-plane already holds it, and "unavailable until activation completes" is fine because git auth isn't needed pre-activation. (Flagged on #817 that its endpoint must accept this credential.) A per-credential credhelper session (B) is more machinery than needed; a brand-new mechanism (C) only if the cloud team requires it.

### Q4: Pre-Expiry Refresh Trigger
**Context**: FR-004 says "synchronously (and/or proactively in the background)" which permits multiple implementations. Pure-sync means we only spend a refresh round-trip when git actually fires; background-timer means we always serve cache hits but spend a refresh round-trip every ~55 min even if no git op runs. The choice affects observability (SC-004 measurement), cloud load, and complexity of the daemon.
**Question**: When the cached token enters the pre-expiry window (~5 min from `expiresAt`), what triggers the refresh?
**Options**:
- A: Synchronous-on-demand only — the next `get` after the window opens performs the fresh fetch and returns the new token; if no `get` arrives, no refresh occurs.
- B: Background timer only — a watcher refreshes whenever `expiresAt - now ≤ 5 min`; the next `get` is always a cache hit (with a sync fallback if the background fetch itself failed).
- C: Both — background timer for proactive refresh, with a sync refresh as a safety net inside `get` if the cached token is still within the window.

**Answer**: **A** — synchronous-on-demand refresh. The next `get` within the pre-expiry window performs the fresh fetch and returns the new token, so every git op is always handed a valid token. No wasteful background mints while the cluster is idle, and the sub-second refresh latency on the first post-window op is negligible. This already satisfies the mid-workflow guarantee, so a background warmer (B/C) adds a timer + idle load for no correctness gain — defer it unless latency/observability later demands it.

### Q5: Git Credential Response Username
**Context**: The git credential-helper protocol's `get` response requires both `username` and `password` lines. GitHub installation tokens are conventionally presented over HTTPS with a fixed sentinel username (`x-access-token`) — this pattern is already used elsewhere in this repo (e.g., `packages/control-plane/src/services/peer-repo-cloner.ts` `x-access-token` URL pattern). A different choice may break existing git op call sites.
**Question**: What `username` field does the helper return in its `get` response?
**Options**:
- A: Constant `x-access-token` (matches the HTTPS pattern already used in `peer-repo-cloner.ts` and is the GitHub-recommended pattern for installation tokens).
- B: The GitHub App slug or installation account login resolved from the credential metadata in `.agency/credentials.yaml`.
- C: Whatever username string the cloud pull response (#817) returns alongside the token.

**Answer**: **A** — constant `x-access-token`. The GitHub-standard sentinel username for installation tokens (token goes in the password line), already used in `packages/control-plane/src/services/peer-repo-cloner.ts:25`, so it won't break existing call sites.
