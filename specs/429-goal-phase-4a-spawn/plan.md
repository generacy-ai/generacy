# Implementation Plan: Migrate SubprocessAgency to AgentLauncher

**Feature**: Route SubprocessAgency through AgentLauncher + GenericSubprocessPlugin
**Branch**: `429-goal-phase-4a-spawn`
**Status**: Complete

## Summary

Migrate `SubprocessAgency.connect()` from direct `child_process.spawn` to `AgentLauncher.launch()` with `pluginId: "generic-subprocess"`. This threads `SubprocessAgency` through the launcher infrastructure so it transparently inherits uid/gid and credentials plumbing in future phases. The migration preserves the `SubprocessAgencyOptions` public type exactly, maintains byte-identical `{command, args, env, cwd, stdio}` composition, and falls back to direct spawn when no launcher is injected.

## Technical Context

**Language/Version**: TypeScript 5.4+ / Node.js 20+
**Primary Dependencies**: `@generacy-ai/orchestrator` (AgentLauncher, ProcessFactory, ChildProcessHandle), `@generacy-ai/workflow-engine` (Logger)
**Storage**: N/A
**Testing**: vitest 4.x
**Target Platform**: Node.js server
**Project Type**: Monorepo (pnpm workspaces)

## Project Structure

### Documentation (this feature)

```text
specs/429-goal-phase-4a-spawn/
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Type changes and interfaces
├── quickstart.md        # Testing guide
├── contracts/           # Interface contracts
├── spec.md              # Feature specification (read-only)
└── clarifications.md    # Q&A from clarify phase
```

### Source Code (repository root)

```text
packages/orchestrator/src/
├── launcher/
│   ├── types.ts                     # MODIFY: add stdioProfile to GenericSubprocessIntent
│   ├── generic-subprocess-plugin.ts # MODIFY: pass through stdioProfile from intent
│   ├── index.ts                     # CREATE: barrel export for launcher module
│   └── __tests__/
│       └── generic-subprocess-plugin.test.ts  # MODIFY: add stdioProfile tests
│
├── worker/types.ts                  # READ-ONLY: ChildProcessHandle interface
└── index.ts                         # MODIFY: export launcher types

packages/generacy/src/
├── agency/
│   ├── subprocess.ts                # MODIFY: add launcher path in connect()
│   └── __tests__/
│       ├── subprocess.test.ts           # CREATE: unit tests (launcher + fallback)
│       └── subprocess-snapshot.test.ts  # CREATE: snapshot parity test
│
└── index.ts                         # READ-ONLY: verify exports unchanged
```

**Structure Decision**: Existing monorepo layout. Changes span two packages: `orchestrator` (enable stdioProfile pass-through) and `generacy` (consume launcher in SubprocessAgency).

## Implementation Phases

### Phase 0: Orchestrator — Enable stdioProfile on GenericSubprocessIntent

**Goal**: Allow callers to specify which stdio profile the plugin uses.

1. **`packages/orchestrator/src/launcher/types.ts`** — Add optional `stdioProfile?: 'default' | 'interactive'` field to `GenericSubprocessIntent`.

2. **`packages/orchestrator/src/launcher/generic-subprocess-plugin.ts`** — In `buildLaunch()`, pass `intent.stdioProfile ?? 'default'` to `LaunchSpec.stdioProfile` instead of hardcoding `'default'`.

3. **`packages/orchestrator/src/launcher/__tests__/generic-subprocess-plugin.test.ts`** — Add test: when intent has `stdioProfile: 'interactive'`, LaunchSpec reflects it. Add test: when omitted, defaults to `'default'`.

### Phase 1: Orchestrator — Export launcher types

**Goal**: Make `AgentLauncher`, `ChildProcessHandle`, and related types importable by the generacy package.

4. **`packages/orchestrator/src/launcher/index.ts`** — Create barrel export for `AgentLauncher`, `GenericSubprocessPlugin`, and all types from `types.ts`.

5. **`packages/orchestrator/src/index.ts`** — Add re-export of launcher module.

### Phase 2: Generacy — Inject AgentLauncher into SubprocessAgency

**Goal**: Route `connect()` through the launcher when available, preserving all behavior.

6. **`packages/generacy/src/agency/subprocess.ts`** — Implementation changes:

   a. **Import**: Import `AgentLauncher` type and `ChildProcessHandle` type from `@generacy-ai/orchestrator`.

   b. **Constructor**: Add a second optional parameter `agentLauncher?: AgentLauncher` (NOT part of `SubprocessAgencyOptions` — keeps the public type unchanged).

   c. **Process field**: Change `private process: ChildProcess | null` to a union or minimal interface that covers both `ChildProcess` and `ChildProcessHandle` (stdin, stdout, stderr, kill).

   d. **connect() — launcher path** (when `this.agentLauncher` is defined):
      - Call `this.agentLauncher.launch({ intent: { kind: 'generic-subprocess', command, args, stdioProfile: 'interactive' }, cwd, env: this.env })`.
      - Extract `handle.process` (a `ChildProcessHandle`).
      - Wire `handle.process.stdout.on('data')` and `handle.process.stderr.on('data')` same as before.
      - Wire `handle.process.exitPromise.then(...)` for exit logging and `connected = false`.
      - Wire `handle.process.exitPromise.catch(...)` for spawn error rejection (replaces `process.on('error')`).
      - Send initialization message and await response (shared with direct path).

   e. **connect() — direct path** (fallback when `this.agentLauncher` is undefined):
      - Existing `spawn()` code, unchanged.

   f. **disconnect()**: Use `this.process.kill()` — works for both types.

   g. **sendMessage()**: Use `this.process.stdin.write()` — works for both types.

### Phase 3: Tests

7. **Unit tests** (`subprocess.test.ts`):
   - Launcher path: mock AgentLauncher, verify `launch()` called with correct intent, verify stdin/stdout wiring.
   - Fallback path: verify direct spawn when no launcher provided.
   - Error propagation: verify launcher `launch()` throw is not silently caught.
   - Spawn error: verify ENOENT-like error produces immediate rejection (via exitPromise rejection).

8. **Snapshot test** (`subprocess-snapshot.test.ts`):
   - Use `RecordingProcessFactory` from orchestrator test-utils.
   - Create an `AgentLauncher` with the recording factory for the `'interactive'` profile.
   - Register `GenericSubprocessPlugin`.
   - Create `SubprocessAgency` with the launcher.
   - Call `connect()` (mocking the subprocess response).
   - Assert `recordingFactory.calls[0]` matches `{ command, args, cwd, env: { ...process.env, ...callerEnv } }`.
   - Compare byte-identical with a snapshot of the direct spawn path.

9. **Type test** (inline in test file):
   - Assert `SubprocessAgencyOptions` is assignable to the original shape (no new required fields).

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Second constructor param (not in options) | Preserves `SubprocessAgencyOptions` type signature exactly as required |
| `stdioProfile: 'interactive'` | Maps to `['pipe', 'pipe', 'pipe']` in conversationProcessFactory, matching current behavior |
| `intent.env = undefined`, `request.env = this.env` | 3-layer merge collapses to `{ ...process.env, ...this.env }` — byte-identical |
| Launcher errors propagate (no silent fallback) | Makes migration verifiable; silent fallback would hide bugs |
| `exitPromise` rejection for spawn errors | Replaces `process.on('error')` — per #426 contract |
| No signal info in exit | Acceptable loss per spec — SubprocessAgency logs but doesn't branch on signal |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| env merge divergence | Snapshot test with `RecordingProcessFactory` asserts byte-identical composition |
| stdin unavailable after migration | `stdioProfile: 'interactive'` selects conversationProcessFactory → `['pipe', 'pipe', 'pipe']` |
| Breaking `SubprocessAgencyOptions` consumers | Type-level test + second constructor param keeps interface unchanged |
| #426 not ready (exitPromise doesn't reject) | Fallback path preserves current error behavior; launcher path documents dependency |
