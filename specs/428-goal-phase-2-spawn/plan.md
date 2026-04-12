# Implementation Plan: Create ClaudeCodeLaunchPlugin (Phase 2)

**Feature**: Create `ClaudeCodeLaunchPlugin` implementing `AgentLaunchPlugin` interface for Claude Code subprocess launches
**Branch**: `428-goal-phase-2-spawn`
**Status**: Complete

## Summary

Add `ClaudeCodeLaunchPlugin` to `@generacy-ai/generacy-plugin-claude-code` as a sibling export alongside the existing `ClaudeCodePlugin`. The plugin implements the Wave 1 `AgentLaunchPlugin` interface, encapsulating all Claude Code CLI command composition — phase execution, PR feedback, and conversation turns — into a single plugin that the `AgentLauncher` can dispatch to. This is a copy-forward change: spawn logic is duplicated from orchestrator internals (not deleted), so existing callers remain untouched. Wave 3 will migrate callers and clean up.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js)
**Primary Dependencies**: `@generacy-ai/orchestrator` (for `AgentLaunchPlugin` interface, `LaunchIntent`, `LaunchSpec`, `OutputParser` types)
**Storage**: N/A
**Testing**: Vitest (unit tests + snapshot assertions via Wave 1 harness)
**Target Platform**: Node.js server (Linux)
**Project Type**: Monorepo package (`packages/generacy-plugin-claude-code`)
**Constraints**: Zero modifications to existing callers; all existing orchestrator tests pass unchanged; `createOutputParser` interface update coordinated with #425 PR
**Scale/Scope**: ~3 new type definitions, 1 plugin class, 1 test file, 1 interface update

## Constitution Check

No constitution file found (`.specify/memory/constitution.md` does not exist). No gates to check.

## Project Structure

### Documentation (this feature)

```text
specs/428-goal-phase-2-spawn/
├── spec.md              # Feature specification (read-only)
├── clarifications.md    # Resolved open questions
├── plan.md              # This file
├── research.md          # Technology decisions and patterns
├── data-model.md        # Type definitions and interfaces
└── quickstart.md        # Usage guide and testing instructions
```

### Source Code (new files)

```text
packages/generacy-plugin-claude-code/src/
├── launch/
│   ├── claude-code-launch-plugin.ts   # ClaudeCodeLaunchPlugin class
│   ├── types.ts                       # PhaseIntent, PrFeedbackIntent, ConversationTurnIntent
│   ├── constants.ts                   # PHASE_TO_COMMAND copy, PTY_WRAPPER, CLI flags
│   └── __tests__/
│       ├── claude-code-launch-plugin.test.ts  # Unit + snapshot tests
│       └── __snapshots__/
│           └── claude-code-launch-plugin.test.ts.snap
├── index.ts                           # MODIFIED: add launch plugin exports

packages/orchestrator/src/
├── launcher/
│   └── types.ts                       # MODIFIED: createOutputParser(intent) signature
├── worker/
│   └── claude-cli-worker.ts           # MODIFIED: register ClaudeCodeLaunchPlugin at boot
```

### Existing files modified

| File | Change | Risk |
|------|--------|------|
| `packages/orchestrator/src/launcher/types.ts` | `createOutputParser()` → `createOutputParser(intent: LaunchIntent)` | Low — Wave 1 hasn't shipped to callers; `GenericSubprocessPlugin` ignores the parameter |
| `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts` | Add `_intent` parameter to `createOutputParser` signature | Low — no-op addition, backward compatible |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Import and register `ClaudeCodeLaunchPlugin` alongside `GenericSubprocessPlugin` | Low — additive only, no behavior change |
| `packages/generacy-plugin-claude-code/src/index.ts` | Export `ClaudeCodeLaunchPlugin` and intent types from `./launch/` | Low — additive exports only |

## Implementation Strategy

### Phase 1: Intent Type Definitions (`launch/types.ts`)

Define the three Claude Code-specific intent types as a discriminated union extending `LaunchIntent`:

1. **`PhaseIntent`** — `kind: "phase"`, `phase: "specify" | "clarify" | "plan" | "tasks" | "implement"`, `sessionId?: string`
   - Excludes `validate` at compile time (clarification Q5)
   - `sessionId` enables session resume for MCP server warmth

2. **`PrFeedbackIntent`** — `kind: "pr-feedback"`, `prNumber: number`, `prompt: string`
   - Caller pre-builds prompt via `buildFeedbackPrompt()` (clarification Q2)
   - `prNumber` retained for logging/tracing

3. **`ConversationTurnIntent`** — `kind: "conversation-turn"`, `message: string`, `sessionId?: string`, `model?: string`, `skipPermissions: boolean`
   - Fields flattened directly on intent (clarification Q1)
   - `cwd` is on `LaunchRequest.cwd`, not on the intent

4. **`ClaudeCodeIntent`** — Union of all three: `PhaseIntent | PrFeedbackIntent | ConversationTurnIntent`

### Phase 2: Constants (`launch/constants.ts`)

Copy from orchestrator without deletion (Wave 3 handles cleanup):

1. **`PHASE_TO_COMMAND`** — Map of phase names to slash commands (from `worker/types.ts:73-80`). Only includes the 5 CLI-backed phases (no `validate`).
2. **`PTY_WRAPPER`** — Python PTY wrapper script (from `conversation-spawner.ts:47-57`). Verbatim copy.
3. **CLI flag constants** — Document that `--verbose` is always included; `--dangerously-skip-permissions` is intent-dependent.

### Phase 3: ClaudeCodeLaunchPlugin (`launch/claude-code-launch-plugin.ts`)

Implements `AgentLaunchPlugin`:

1. **`pluginId`**: `"claude-code"`
2. **`supportedKinds`**: `["phase", "pr-feedback", "conversation-turn"]`

3. **`buildLaunch(intent)`** — Discriminates by `intent.kind`:

   **Phase intent** → `{ command: "claude", args, stdioProfile: "default" }`
   - Args: `['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose']`
   - Append `--resume <sessionId>` if present
   - Append prompt: `${PHASE_TO_COMMAND[phase]} <prompt>` (note: prompt comes from `LaunchRequest` — see design decision below)

   **PR feedback intent** → `{ command: "claude", args, stdioProfile: "default" }`
   - Args: `['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose', prompt]`
   - Identical pattern to phase but no slash command prefix and no resume

   **Conversation turn intent** → `{ command: "python3", args, stdioProfile: "interactive" }`
   - Claude args: `['claude', '-p', message, '--output-format', 'stream-json', '--verbose']`
   - Conditionally: `--resume`, `--dangerously-skip-permissions`, `--model`
   - Wrapped: `['python3', '-u', '-c', PTY_WRAPPER, ...claudeArgs]`
   - Returns `stdioProfile: "interactive"` (all stdio piped)

4. **`createOutputParser(intent)`** — Returns appropriate parser:
   - Phase / PR feedback: stream-json parser (wraps existing `OutputCapture` pattern)
   - Conversation turn: PTY output parser (same stream-json under PTY wrapper)
   - Initial implementation: no-op parser (same as `GenericSubprocessPlugin`), since callers still use their own `OutputCapture` instances. Parser logic moves in Wave 3 when callers migrate.

### Phase 4: Interface Update (coordinated with #425)

Update `AgentLaunchPlugin.createOutputParser()` → `createOutputParser(intent: LaunchIntent)`:

1. Modify `packages/orchestrator/src/launcher/types.ts` — add `intent` parameter
2. Modify `GenericSubprocessPlugin.createOutputParser(_intent)` — accept and ignore
3. This is safe because Wave 1 hasn't shipped to any callers yet

### Phase 5: Registration at Boot

In `ClaudeCliWorker` constructor (after existing `GenericSubprocessPlugin` registration):
```typescript
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';
this.agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
```

### Phase 6: Exports

Add to `packages/generacy-plugin-claude-code/src/index.ts`:
- `ClaudeCodeLaunchPlugin` class export
- Intent type exports: `PhaseIntent`, `PrFeedbackIntent`, `ConversationTurnIntent`, `ClaudeCodeIntent`

### Phase 7: Tests

**Snapshot tests** (`claude-code-launch-plugin.test.ts`):
- `buildLaunch()` snapshot for phase intent (each of 5 phases)
- `buildLaunch()` snapshot for phase intent with `sessionId` (resume path)
- `buildLaunch()` snapshot for pr-feedback intent
- `buildLaunch()` snapshot for conversation-turn intent (all flag combinations)
- Verify snapshots match current direct-spawn output from `CliSpawner`, `PrFeedbackHandler`, `ConversationSpawner`

**Unit tests**:
- Plugin identity: `pluginId === "claude-code"`, `supportedKinds` contains all 3 kinds
- `createOutputParser(intent)` returns a valid `OutputParser` for each intent kind
- Unsupported intent kind (defensive)

**Integration sanity test**:
- `AgentLauncher` with registered `ClaudeCodeLaunchPlugin`
- `launcher.launch({ intent: { kind: "phase", ... }, cwd, env })` routes to plugin
- Uses `RecordingProcessFactory` from Wave 1 harness

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Plugin lives in `generacy-plugin-claude-code`, not orchestrator | The package already owns Claude Code integration; keeps orchestrator generic |
| Copy constants, don't import from orchestrator internals | Avoid cross-package coupling on internal types; Wave 3 deletes orchestrator copies |
| `createOutputParser` returns no-op initially | Existing callers own their `OutputCapture`; parser logic migrates in Wave 3 |
| Phase prompt is on the intent (not separate) | `buildLaunch` must be a pure function of its inputs; all data needed to compose the command must be on the intent |
| `stdioProfile: "interactive"` for conversation turns | Conversation turns need stdin piped for PTY wrapper; phase/pr-feedback use `"default"` (stdin ignored) |
| Exclude `validate` from `PhaseIntent.phase` type | Compile-time safety: validate runs via `GenericSubprocessPlugin` as a shell intent |
| `--verbose` always, `--dangerously-skip-permissions` per-intent | Matches current behavior across all three spawn sites |

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Snapshot mismatch between plugin and direct-spawn | Medium | High | Use Wave 1 `RecordingProcessFactory` to capture "before" from live spawn paths; compare byte-for-byte |
| `createOutputParser(intent)` interface change breaks Wave 1 tests | Low | Low | Wave 1 tests call `createOutputParser()` with no args; TypeScript allows omitting optional params. Update test to pass intent. |
| Circular dependency between plugin package and orchestrator | Low | High | Plugin imports only types from orchestrator (`AgentLaunchPlugin`, `LaunchSpec`); types are type-only imports, no runtime dependency |
| Phase prompt composition differs between plugin and `CliSpawner` | Medium | Medium | Snapshot tests against live `CliSpawner` output catch any divergence |

## Complexity Tracking

No constitution violations. The implementation adds one new directory (`launch/`) in the existing plugin package with ~3 source files and ~1 test file. The only cross-package change is the `createOutputParser` signature update (coordinated, non-breaking).
