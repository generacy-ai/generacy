# Clarifications: Orchestrator GitHub monitors credential resolution via credhelper

## Batch 1 — 2026-05-14

### Q1: Token Sourcing Mechanism
**Context**: The spec recommends Option A with a `tokenProvider` that is "credhelper-backed", but FR-004 also describes a transitional path reading from `wizard-credentials.env`. The credhelper daemon's HTTP session API (`beginSession`/`endSession`) is designed for child process lifetimes, not long-lived in-process polling loops. Meanwhile, `wizard-credentials.env` is written once at bootstrap by the control-plane process and contains a pre-minted `GH_TOKEN`.
**Question**: For the Option A token provider, should the implementation: (a) call the credhelper daemon's HTTP API to mint a fresh token per poll cycle, (b) re-read `/var/lib/generacy/wizard-credentials.env` on each poll cycle to pick up refreshed tokens, or (c) read from the encrypted credential backend (`ClusterLocalBackend.fetchSecret()`) directly within the orchestrator process?
**Options**:
- A: Credhelper daemon HTTP API (session-based, mirrors worker pattern but adds session lifecycle complexity for long-lived monitors)
- B: Re-read `wizard-credentials.env` file each poll cycle (simplest, but depends on external refresh of that file)
- C: Direct `ClusterLocalBackend.fetchSecret()` in-process (no daemon dependency, but duplicates backend access and bypasses credhelper's plugin logic)

**Answer**: **B** — Re-read `/var/lib/generacy/wizard-credentials.env` on each poll cycle. Simplest correct answer; composes with cloud-side proactive refresh (#577). File is already kept fresh by `handlePutCredential` (#614). Option C breaks credhelper isolation boundary (only daemon should hold master key). Follow-up issue can replace file read with credhelper-backed provider (B2 from original spec).

### Q2: GhCliGitHubClient Constructor Compatibility
**Context**: `GhCliGitHubClient` lives in the shared `packages/workflow-engine/` package. Its constructor currently takes only `workdir?: string`, and `GitHubClientFactory` is typed as `(workdir?) => GitHubClient`. Adding `tokenProvider` changes the public API surface of a shared package consumed by multiple callers (conversation workers, monitors, CLI utils).
**Question**: Should `tokenProvider` be an optional parameter (preserving backward compatibility so existing callers without tokens continue to work via ambient env), or should it be required (forcing all callsites to explicitly provide or opt out of token injection)?
**Options**:
- A: Optional parameter with ambient env fallback (backward compatible, but allows silent regression to ambient auth)
- B: Required parameter, passing `undefined` or a no-op provider to opt out (explicit, but requires updating all callsites)

**Answer**: **B** — Required parameter, callers opt out by passing `undefined`. Only 5 `createGitHubClient` callsites in the orchestrator repo. Worker callsites pass `undefined` (they run inside credhelper sessions with `GH_TOKEN` in env). Orchestrator-process callsites pass the wizard-creds-env provider.

### Q3: Monitor Session Lifecycle
**Context**: The credhelper interceptor pattern (`credentials-interceptor.ts`) uses `beginSession()`/`endSession()` for child processes with bounded lifetimes. Monitors are long-lived services that poll every 30-60 seconds indefinitely. Session-per-poll adds overhead; a single long-lived session may hold stale tokens.
**Question**: If using the credhelper daemon (Q1 option A), what session lifecycle should monitors follow: one long-lived session for the monitor's lifetime, or a new session per poll cycle?
**Options**:
- A: One long-lived session (lower overhead, but token may go stale if credhelper doesn't auto-refresh within a session)
- B: New session per poll cycle (guaranteed fresh token, but adds begin/end overhead every 30-60s)
- C: Session-less — call a new lightweight "fetch token" endpoint without session lifecycle (requires credhelper API extension)

**Answer**: **N/A** given Q1=B. Credhelper session model deferred to follow-up. If Q1 were A, option C (session-less fetch) would be required because: (A) long-lived session hands `gh` a stale token after first refresh tick, (B) new session per poll churns sessions for one CLI invocation.

### Q4: Token Resolution Failure Behavior
**Context**: During early boot (before `wizard-credentials.env` exists) or if credhelper is temporarily unavailable, the token provider will fail. The spec says monitors should resolve credentials "at poll time" (US3) but doesn't specify what happens when resolution fails.
**Question**: When the token provider fails to resolve a credential, should the monitor: skip that poll cycle and retry next interval, apply exponential backoff, or enter a degraded state with alerting?
**Options**:
- A: Skip cycle, log warning, retry at normal interval (simple, tolerates transient failures)
- B: Skip cycle with exponential backoff (avoids log spam during extended outages)
- C: Skip cycle, emit relay event on `cluster.monitors` channel so cloud can surface the issue (observable)

**Answer**: **A** — Skip cycle, log warning, retry at normal interval. Implementation note: log on state transition (started failing → resumed) rather than every cycle, so exactly one warning per outage rather than 240/hr.

### Q5: Scope of FR-005 (Non-Monitor gh CLI Users)
**Context**: FR-005 says "Existing `handlePutCredential` → `refreshGhAuth` path continues to work for non-monitor consumers." The spec is unclear about what other `gh` CLI consumers exist in the orchestrator beyond the monitors, and whether they should also eventually migrate to the token provider pattern.
**Question**: Are there other `gh` CLI consumers in the orchestrator (beyond PR feedback and label monitors) that currently depend on ambient `gh auth` state, and should this issue address them or are they explicitly out of scope?
**Options**:
- A: Only monitors are in scope; any other `gh` consumers keep using ambient auth (smallest change)
- B: All orchestrator-process `gh` consumers should migrate to token provider in this issue (comprehensive but larger scope)

**Answer**: **Expanded scope** — All in-orchestrator-process `gh` consumers, workers stay on ambient env. Two additional consumers found beyond monitors: `LabelSyncService` (instantiated in `server.ts:151` via `createGitHubClient`) and `WebhookSetupService` (shells out to `gh` directly at `services/webhook-setup-service.ts:431, 490, 555`). All 4 orchestrator-process consumers in-scope. Worker-process callers (`claude-cli-worker.ts:218`, `pr-feedback-handler.ts:98`) out of scope — they run inside credhelper-managed sessions.
