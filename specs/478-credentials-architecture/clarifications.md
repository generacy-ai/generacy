# Clarifications: Credentials Integration Gap Fix (Phase 6)

## Batch 1 — 2026-04-15

### Q1: Config Threading Approach
**Context**: The spec states "most sites already receive the config via their constructor or a factory," but code analysis shows this is not the case. `CliSpawner` receives only `(agentLauncher, logger, shutdownGracePeriodMs)`. `ConversationSpawner` receives no config at all. `WorkerConfig` (used by the orchestrator) does not include `defaults.role` — only `GeneracyConfig` (from `@generacy-ai/config`) has it.
**Question**: Should we (A) add a `credentialRole` field to `WorkerConfig` and extract it from `GeneracyConfig` at orchestrator startup, keeping the existing DI shape, or (B) thread the full `GeneracyConfig` object to spawn sites alongside `WorkerConfig`?
**Options**:
- A: Add `credentialRole` to WorkerConfig — minimal DI changes, single string flows through existing plumbing
- B: Thread full GeneracyConfig — more flexible but requires wider constructor changes across spawn sites

**Answer**: A — add `credentialRole` field to `WorkerConfig`.**

Minimal DI changes, single string flows through existing plumbing. The orchestrator startup extracts `config.defaults?.role` from `GeneracyConfig` once and stores it in `WorkerConfig`:

```typescript
const workerConfig: WorkerConfig = {
  // ...existing fields
  credentialRole: generacyConfig.defaults?.role,
};
```

Spawn sites read `workerConfig.credentialRole` and build the `credentials` field on `LaunchRequest` if it's set.

If future fields need to flow through (per-step role overrides, etc.), add them to `WorkerConfig` at that point. Don't pre-thread the full `GeneracyConfig` for hypothetical needs — that creates a wider surface of changes in this issue and couples spawn sites to config schema details they don't need to know.

---

### Q2: Generic Launcher Paths Scope
**Context**: The spec lists `packages/workflow-engine/src/actions/cli-utils.ts` and `packages/generacy/src/agency/subprocess.ts` as callers to update. However, `cli-utils.ts` uses a generic `launcher` function signature `(options) => handle` — not `AgentLauncher.launch()` — so the `LaunchRequest.credentials` field doesn't apply. `subprocess.ts` has a direct-spawn fallback when no `agentLauncher` is provided.
**Question**: Should credentials be wired through these two generic launcher paths in this issue (requiring interface changes to the launcher function signature and subprocess fallback), or should they be deferred to a follow-up?
**Options**:
- A: Wire credentials through all 7 paths now — ensures complete coverage but requires more interface changes
- B: Defer cli-utils.ts and subprocess.ts to a follow-up — focus on the 5 orchestrator-internal spawn sites first

**Answer**: B — defer `cli-utils.ts` and `subprocess.ts` to a follow-up issue.**

The 5 orchestrator-internal sites all use `AgentLauncher.launch()` with `LaunchRequest` — credentials wiring is a localized change. The generic launcher paths use a different abstraction (`launcher: (options) => handle` in cli-utils, direct-spawn fallback in subprocess) that doesn't currently carry a credentials concept.

Wiring credentials through those would require:
- Designing how the generic `launcher` function signature carries credentials
- Updating the subprocess fallback (or removing it in favor of always going through AgentLauncher)
- Decisions about whether workflow-engine actions and MCP subprocess agency should always inherit workflow credentials, or have an opt-out

That's a separate design + implementation pass. Doing it in this issue would balloon the scope and risk holding up the orchestrator-internal wiring that unblocks Phase 6 testing.

**Important caveat that should be in the issue body:** until the follow-up lands, workflows running with `defaults.role` will have **partial coverage** — the agent itself runs with credentials, but workflow actions that spawn subprocesses via cli-utils (e.g., `git push`, custom CLI actions) and MCP servers loaded via subprocess.ts will run as the worker uid without scoping. This is a documented limitation, not a silent gap.

**Action item**: File a follow-up issue in this same repo titled something like "Wire credentials through generic launcher paths (cli-utils.ts, subprocess.ts)" with the design questions above. Reference it from the Phase 6 wrap-up.

---

### Q3: Role Configured but Daemon Unavailable
**Context**: The spec independently checks socket existence (for `CredhelperClient`) and `config.defaults.role` (for credentials). If `defaults.role` is set but the credhelper socket doesn't exist, `credhelperClient` will be `undefined`. When `AgentLauncher.launch()` receives `credentials` but has no client, it throws `CredhelperUnavailableError` — a hard failure that kills the workflow step.
**Question**: When `defaults.role` is configured but the credhelper daemon is unavailable, should the system (A) throw a hard error indicating misconfiguration, (B) log a warning and fall back to legacy mode (omit credentials), or (C) have callers only populate credentials when the client is also available?
**Options**:
- A: Hard error — fail fast, role without daemon is a misconfiguration
- B: Warning + fallback — degrade gracefully, log that credentials were skipped
- C: Callers check client availability — only build credentials when both role and client exist

**Answer**: A — hard error with a clear actionable message.**

Setting `defaults.role` is an explicit opt-in to credential isolation. If the developer asked for credentials and the daemon isn't available, that's a misconfiguration — silent degradation defeats the security model and creates confusing failure modes (workflows that "work" but use the wrong credentials).

The error must be actionable, not just informative:

```
CredhelperUnavailableError: defaults.role is set to 'developer' in .generacy/config.yaml,
  but the credhelper daemon is not reachable at /run/generacy-credhelper/control.sock.

  To fix:
    - Run 'stack credhelper start' to start the daemon, or
    - Remove 'defaults.role' from .generacy/config.yaml to disable credentials.

  See: https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md
```

This makes the contract explicit:
- `defaults.role` set + daemon running → use credentials
- `defaults.role` set + daemon NOT running → hard error (above)
- `defaults.role` NOT set → no credentials, no credhelper needed (legacy mode, fully backwards compatible)

Option B (warning + fallback) silently runs workflows in legacy mode when the user expected credentials. Option C (caller checks client availability) is the same outcome as B but invisible — even worse.

The check should happen at orchestrator startup (when the config is loaded), not per-launch. Failing fast at startup means the developer sees the error immediately, not after waiting for a workflow to spawn.

---

### Q4: Conversation Turn Credential Scope
**Context**: The spec lists `conversation-spawner.ts` as a caller to update. Conversation turns are interactive user sessions (e.g., a developer chatting with the agent), which have different trust and lifecycle characteristics than automated workflow phases or PR feedback handlers.
**Question**: Should interactive conversation turns receive the same credential isolation as automated workflow steps, or should they be excluded from credential wiring (keeping legacy behavior for interactive sessions)?
**Options**:
- A: Include conversation turns — all spawn paths get credentials uniformly
- B: Exclude conversation turns — only automated workflow steps (phase, validate, pr-feedback) get credentials

**Answer**: A — include conversation turns. All spawn paths get credentials uniformly.**

A conversation turn spawns the agent CLI just like a phase or PR feedback handler. If the developer has configured a role, they expect it to apply consistently. Excluding interactive sessions creates a security inconsistency: the same agent binary runs with different privileges depending on whether you invoke it via a workflow phase or a chat — that's surprising and dangerous.

For v1.5 with `defaults.role` being a single config setting, uniform application is the right model. If per-mode role selection is needed later (e.g., a `defaults.interactiveRole: reviewer` for chat sessions vs. `defaults.role: developer` for workflows), it can be added then. Don't bake the inconsistency in now.
