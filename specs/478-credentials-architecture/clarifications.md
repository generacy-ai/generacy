# Clarifications: Credentials Integration Gap Fix (Phase 6)

## Batch 1 — 2026-04-15

### Q1: Config Threading Approach
**Context**: The spec states "most sites already receive the config via their constructor or a factory," but code analysis shows this is not the case. `CliSpawner` receives only `(agentLauncher, logger, shutdownGracePeriodMs)`. `ConversationSpawner` receives no config at all. `WorkerConfig` (used by the orchestrator) does not include `defaults.role` — only `GeneracyConfig` (from `@generacy-ai/config`) has it.
**Question**: Should we (A) add a `credentialRole` field to `WorkerConfig` and extract it from `GeneracyConfig` at orchestrator startup, keeping the existing DI shape, or (B) thread the full `GeneracyConfig` object to spawn sites alongside `WorkerConfig`?
**Options**:
- A: Add `credentialRole` to WorkerConfig — minimal DI changes, single string flows through existing plumbing
- B: Thread full GeneracyConfig — more flexible but requires wider constructor changes across spawn sites

**Answer**: *Pending*

### Q2: Generic Launcher Paths Scope
**Context**: The spec lists `packages/workflow-engine/src/actions/cli-utils.ts` and `packages/generacy/src/agency/subprocess.ts` as callers to update. However, `cli-utils.ts` uses a generic `launcher` function signature `(options) => handle` — not `AgentLauncher.launch()` — so the `LaunchRequest.credentials` field doesn't apply. `subprocess.ts` has a direct-spawn fallback when no `agentLauncher` is provided.
**Question**: Should credentials be wired through these two generic launcher paths in this issue (requiring interface changes to the launcher function signature and subprocess fallback), or should they be deferred to a follow-up?
**Options**:
- A: Wire credentials through all 7 paths now — ensures complete coverage but requires more interface changes
- B: Defer cli-utils.ts and subprocess.ts to a follow-up — focus on the 5 orchestrator-internal spawn sites first

**Answer**: *Pending*

### Q3: Role Configured but Daemon Unavailable
**Context**: The spec independently checks socket existence (for `CredhelperClient`) and `config.defaults.role` (for credentials). If `defaults.role` is set but the credhelper socket doesn't exist, `credhelperClient` will be `undefined`. When `AgentLauncher.launch()` receives `credentials` but has no client, it throws `CredhelperUnavailableError` — a hard failure that kills the workflow step.
**Question**: When `defaults.role` is configured but the credhelper daemon is unavailable, should the system (A) throw a hard error indicating misconfiguration, (B) log a warning and fall back to legacy mode (omit credentials), or (C) have callers only populate credentials when the client is also available?
**Options**:
- A: Hard error — fail fast, role without daemon is a misconfiguration
- B: Warning + fallback — degrade gracefully, log that credentials were skipped
- C: Callers check client availability — only build credentials when both role and client exist

**Answer**: *Pending*

### Q4: Conversation Turn Credential Scope
**Context**: The spec lists `conversation-spawner.ts` as a caller to update. Conversation turns are interactive user sessions (e.g., a developer chatting with the agent), which have different trust and lifecycle characteristics than automated workflow phases or PR feedback handlers.
**Question**: Should interactive conversation turns receive the same credential isolation as automated workflow steps, or should they be excluded from credential wiring (keeping legacy behavior for interactive sessions)?
**Options**:
- A: Include conversation turns — all spawn paths get credentials uniformly
- B: Exclude conversation turns — only automated workflow steps (phase, validate, pr-feedback) get credentials

**Answer**: *Pending*
