# Clarifications for #430: Migrate executeCommand / executeShellCommand to AgentLauncher

## Batch 1 — 2026-04-12

### Q1: Cross-package dependency approach
**Context**: `workflow-engine` has no dependency on `orchestrator` (dependency flows `orchestrator → workflow-engine`). `AgentLauncher` lives in `orchestrator`. The spec lists three approaches (DI, shared package, interface adapter) but doesn't specify which to use. This decision shapes the entire implementation.
**Question**: Which approach should be used to resolve the cross-package dependency?
**Options**:
- A: **Dependency injection** — Accept a launcher (or launch function) as an optional parameter on `executeCommand`/`executeShellCommand`
- B: **Shared package** — Extract launcher types to a shared package that both can depend on
- C: **Interface adapter** — Define a minimal `ProcessLauncher` interface in `workflow-engine` that `AgentLauncher` satisfies

**Answer**: **C — Module-level registration.** `workflow-engine` has no dependency on `orchestrator` and must not acquire one. Define a `LaunchFunction` type locally in `workflow-engine`, expose `registerProcessLauncher()`, and have the orchestrator call it once at boot. No orchestrator types imported. *(Answered by @christrudelpw on GitHub)*

### Q2: ProcessFactory detached mode and group-kill mechanism
**Context**: Neither `defaultProcessFactory` nor `conversationProcessFactory` sets `detached: true` in spawn options. Additionally, `ChildProcessHandle.kill()` delegates to `child.kill(signal)` which kills only the child process, not the process group. The current `executeCommand`/`executeShellCommand` functions rely on both `detached: true` AND `process.kill(-pid, 'SIGTERM')` for group-kill semantics (timeout and abort-signal handling). The spec says changes to `GenericSubprocessPlugin` or `AgentLauncher` APIs are out of scope, but doesn't mention `ProcessFactory`.
**Question**: How should `detached: true` and process-group kill support be added?
**Options**:
- A: **Extend ProcessFactory** — Add `detached` flag to `ProcessFactory.spawn()` options and add `killGroup()` method to `ChildProcessHandle` interface
- B: **New factory variant** — Create a dedicated `DetachedProcessFactory` that sets `detached: true` and provides group-kill via its handle
- C: **Wrapper-level handling** — Don't modify ProcessFactory; have the `executeCommand`/`executeShellCommand` wrappers access `handle.pid` and call `process.kill(-pid, signal)` directly

**Answer**: **A (partial) — Extend ProcessFactory with `detached?: boolean`, but keep group-kill at wrapper level.** Add `detached?: boolean` to `ProcessFactory.spawn()` options (coordinate with #426). The wrapper continues to call `process.kill(-handle.pid, 'SIGTERM')` directly — no `killGroup()` method needed. Group-kill is caller-specific logic. *(Answered by @christrudelpw on GitHub)*

### Q3: Backward-compatible fallback vs. strict migration
**Context**: If dependency injection is chosen (Q1 option A), external consumers of `@generacy-ai/workflow-engine` who don't provide a launcher would need updating. The acceptance criteria states "no direct `child_process.spawn` calls remain in `executeCommand` or `executeShellCommand`", but US2 requires the refactor to be "invisible" to downstream consumers. These two requirements conflict if fallback to direct spawn is needed for backward compatibility.
**Question**: How should this tension be resolved?
**Options**:
- A: **Optional with fallback** — Launcher is optional; fall back to direct spawn when not provided (backward-compatible, but direct spawn calls remain as fallback code path)
- B: **Required launcher** — Launcher is always required; update all call sites (clean migration, but breaking change for external consumers)
- C: **Module-level registration** — Provide a `setLauncher()` function that configures the module once; internal calls always use the registered launcher, no API signature changes needed

**Answer**: **C combined with fallback — Module-level registration with direct-spawn fallback when unregistered.** Internal callers get the launcher via `registerProcessLauncher()` at boot. External npm consumers who never register get fallback to direct `child_process.spawn` — zero breaking change. The fallback path should be allow-listed in Wave 5 lint rule (#437). *(Answered by @christrudelpw on GitHub)*
