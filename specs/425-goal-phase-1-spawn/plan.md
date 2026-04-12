# Implementation Plan: Introduce AgentLauncher + GenericSubprocessPlugin (Phase 1)

**Feature**: Introduce `AgentLauncher` abstraction layer with plugin registry and `GenericSubprocessPlugin` pass-through
**Branch**: `425-goal-phase-1-spawn`
**Status**: Complete

## Summary

Add the `AgentLauncher` class inside `@generacy-ai/orchestrator` as a new, internal module with zero caller migrations. It provides a plugin-based dispatch layer for process launches: callers submit a `LaunchRequest` containing a `LaunchIntent`, the launcher resolves the correct `AgentLaunchPlugin` from its registry, delegates command/args/env construction to the plugin's `buildLaunch()`, merges environment variables (process.env ← plugin env ← caller env), selects a `ProcessFactory` by stdio profile, spawns the process, and returns a thin `LaunchHandle`. The `GenericSubprocessPlugin` ships in the same change as a pass-through for `generic-subprocess` and `shell` intents.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js)
**Primary Dependencies**: `@generacy-ai/orchestrator` (internal module), Node.js `child_process` (via existing `ProcessFactory`)
**Storage**: N/A
**Testing**: Vitest (unit tests + snapshot tests)
**Target Platform**: Node.js server (Linux)
**Project Type**: Monorepo package (`packages/orchestrator`)
**Constraints**: Zero modifications to existing callers; all existing tests must pass unchanged
**Scale/Scope**: ~6 new type definitions, 1 class, 1 plugin, 1 test file

## Constitution Check

No constitution file found (`.specify/memory/constitution.md` does not exist). No gates to check.

## Project Structure

### Documentation (this feature)

```text
specs/425-goal-phase-1-spawn/
├── spec.md              # Feature specification (read-only)
├── clarifications.md    # Resolved open questions
├── plan.md              # This file
├── research.md          # Technology decisions and patterns
├── data-model.md        # Type definitions and interfaces
└── quickstart.md        # Usage guide and testing instructions
```

### Source Code (new files)

```text
packages/orchestrator/src/
├── launcher/
│   ├── types.ts                    # LaunchIntent, LaunchRequest, LaunchSpec, LaunchHandle,
│   │                               #   AgentLaunchPlugin, OutputParser
│   ├── agent-launcher.ts           # AgentLauncher class (registry + launch method)
│   ├── generic-subprocess-plugin.ts # GenericSubprocessPlugin (pass-through for
│   │                               #   generic-subprocess + shell intents)
│   └── __tests__/
│       ├── agent-launcher.test.ts  # Registry, env merge, factory selection, signal propagation
│       └── generic-subprocess-plugin.test.ts # Snapshot tests for buildLaunch() + unit tests
├── worker/
│   ├── claude-cli-worker.ts        # MODIFIED: register GenericSubprocessPlugin at boot
│   └── types.ts                    # UNCHANGED (ProcessFactory, ChildProcessHandle reused as-is)
└── index.ts                        # UNCHANGED (no new exports)
```

### Existing files modified

| File | Change | Risk |
|------|--------|------|
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Add `AgentLauncher` instantiation + `GenericSubprocessPlugin` registration in constructor | Low — additive only, no behavior change to existing code paths |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Update `defaultProcessFactory` to NOT merge `process.env` (FR-008) | Low — `AgentLauncher` callers pass pre-merged env; existing callers still go through old path |
| `packages/orchestrator/src/conversation/process-factory.ts` | Update `conversationProcessFactory` to NOT merge `process.env` (FR-008) | Low — same mechanical change; existing callers pass `{ ...process.env, ...env }` already |

**Important**: The factory `process.env` removal (FR-008) only affects the `AgentLauncher` code path. Existing callers (`CliSpawner`, `ConversationSpawner`, `PrFeedbackHandler`) pass env through their own merging logic, so this is a no-op for them — they already pass `{ ...process.env, ...options.env }` or `{}` (relying on factory merge). **Wait** — since existing callers rely on the factory merging `process.env`, removing that merge would break them. Per clarification Q4, the factory change lands in the same PR, but we must ensure existing callers are updated to pass pre-merged env. However, that conflicts with "zero caller changes."

**Revised approach for FR-008**: Keep the existing factories unchanged. Instead, `AgentLauncher` performs its own 3-layer env merge (`process.env ← plugin env ← caller env`) and passes the fully-merged result to `ProcessFactory.spawn()`. The factory's internal `{ ...process.env, ...options.env }` merge becomes a harmless double-merge of `process.env` (idempotent since the launcher already included it). This preserves zero caller changes while establishing the correct merge semantics for the launcher path. The factory cleanup (removing their `process.env` merge) can happen in Wave 2+ when callers are migrated to use `AgentLauncher`.

### Revised files modified

| File | Change | Risk |
|------|--------|------|
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Add `AgentLauncher` instantiation + `GenericSubprocessPlugin` registration in constructor | Low — additive only |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | NO factory changes in Phase 1 | None |
| `packages/orchestrator/src/conversation/process-factory.ts` | NO changes in Phase 1 | None |

## Implementation Strategy

### Phase 1: Type Definitions (`launcher/types.ts`)

Define all core types as pure TypeScript interfaces/types:

1. **`LaunchIntent`** — Discriminated union with `kind` field. Phase 1 defines:
   - `GenericSubprocessIntent` (`kind: "generic-subprocess"`) — command, args, env
   - `ShellIntent` (`kind: "shell"`) — command (string), env
2. **`LaunchRequest`** — Intent + caller env overrides + optional `AbortSignal` + cwd
3. **`LaunchSpec`** — Plugin output: command, args, env, `stdioProfile` (defaults to `"default"`)
4. **`AgentLaunchPlugin`** — Interface: `pluginId`, `supportedKinds`, `buildLaunch(intent)`, `createOutputParser()`
5. **`OutputParser`** — Interface: `processChunk(stream, data)` + `flush()`
6. **`LaunchHandle`** — `process: ChildProcessHandle`, `outputParser: OutputParser`, `metadata`

### Phase 2: AgentLauncher Class (`launcher/agent-launcher.ts`)

1. Constructor accepts `Map<string, ProcessFactory>` (stdio profile → factory) and optional pre-registered plugins
2. `registerPlugin(plugin)` — adds to internal `Map<string, AgentLaunchPlugin>`
3. `launch(request: LaunchRequest): LaunchHandle`:
   - Resolve plugin by matching `request.intent.kind` against registered plugins' `supportedKinds`
   - Call `plugin.buildLaunch(request.intent)` → `LaunchSpec`
   - Merge env: `{ ...process.env, ...launchSpec.env, ...request.env }`
   - Select `ProcessFactory` by `launchSpec.stdioProfile ?? "default"`
   - Call `factory.spawn(launchSpec.command, launchSpec.args, { cwd: request.cwd, env: mergedEnv, signal: request.signal })`
   - Create output parser via `plugin.createOutputParser()`
   - Return `LaunchHandle` wrapping process + parser

### Phase 3: GenericSubprocessPlugin (`launcher/generic-subprocess-plugin.ts`)

1. `pluginId: "generic-subprocess"`
2. `supportedKinds: ["generic-subprocess", "shell"]`
3. `buildLaunch(intent)`:
   - For `generic-subprocess`: pass through command, args, env directly
   - For `shell`: wrap in `sh -c <command>`, pass env
   - Both return `stdioProfile: "default"`
4. `createOutputParser()`: returns a no-op passthrough parser

### Phase 4: Registration at Boot

In `ClaudeCliWorker` constructor:
- Create `AgentLauncher` with `{ "default": defaultProcessFactory, "interactive": conversationProcessFactory }`
- Register `GenericSubprocessPlugin`
- Store launcher as `private readonly agentLauncher` (unused by existing code paths in Phase 1)

### Phase 5: Tests

**Unit tests** (`agent-launcher.test.ts`):
- Registry lookup succeeds for registered plugin
- Unknown plugin kind throws descriptive error (FR-013)
- Env merge: caller env overrides plugin env overrides process.env
- Correct `ProcessFactory` selected by `stdioProfile`
- `AbortSignal` propagated to `ProcessFactory.spawn()`
- `LaunchHandle` exposes process and output parser

**Snapshot tests** (`generic-subprocess-plugin.test.ts`):
- `buildLaunch()` snapshot for `kind: "generic-subprocess"` intent
- `buildLaunch()` snapshot for `kind: "shell"` intent

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Plugin lookup by `supportedKinds` array (not `pluginId` matching `intent.kind`) | A single plugin can handle multiple intent kinds (GenericSubprocessPlugin handles both `generic-subprocess` and `shell`) |
| Env merge in launcher, not in factories | Avoids breaking existing callers; factory `process.env` merge is idempotent double-merge for launcher path |
| `stdioProfile` string key (not enum) | Extensible without modifying the type; new profiles can be registered at runtime |
| Thin `LaunchHandle` (no lifecycle) | Per clarification Q5; lifecycle consolidation deferred to Wave 3 |
| Only 2 intent kinds in Phase 1 | Per clarification Q3; TypeScript unions are naturally additive |
| Internal module (not re-exported) | FR-012; prevents external coupling before the API stabilizes |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Double `process.env` merge via factories | Idempotent — spreading same keys is harmless; factory cleanup deferred to caller migration waves |
| Type drift between `LaunchIntent` and plugin `supportedKinds` | Compile-time: `buildLaunch()` accepts `LaunchIntent` discriminated union; runtime: throw on unsupported kind |
| Breaking existing tests | Zero modifications to existing code paths; launcher is purely additive |

## Complexity Tracking

No constitution violations. The implementation adds a single new module directory (`launcher/`) with ~3 source files and ~2 test files. No new dependencies, no new abstractions beyond what the spec requires.
