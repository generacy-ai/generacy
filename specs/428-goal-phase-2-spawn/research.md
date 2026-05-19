# Research: ClaudeCodeLaunchPlugin (Phase 2)

**Feature**: #428 — Create ClaudeCodeLaunchPlugin
**Date**: 2026-04-12

## Technology Decisions

### 1. Plugin Location: `generacy-plugin-claude-code` package

**Decision**: Place `ClaudeCodeLaunchPlugin` in the existing `@generacy-ai/generacy-plugin-claude-code` package.

**Rationale**: The package already owns Claude Code integration (container-managed `ClaudeCodePlugin`). The launch plugin is a sibling abstraction for subprocess-based launches. This keeps Claude Code-specific knowledge (CLI flags, PTY wrapper, phase commands) consolidated in one package rather than spreading it across orchestrator internals.

**Alternative rejected**: Placing in `packages/orchestrator/src/launcher/` — this would keep Claude-specific knowledge in the generic orchestrator, contradicting the plugin architecture's goal of separating concerns.

### 2. Copy-Forward Pattern (Not Import)

**Decision**: Copy `PHASE_TO_COMMAND` map, PTY wrapper script, and CLI flag patterns into the plugin package as standalone constants.

**Rationale**: Wave 3 will delete these from orchestrator internals. If the plugin imported from orchestrator, Wave 3 deletion would break the plugin. The copy-forward pattern makes Wave 3 a clean deletion without dependency analysis.

**Alternative rejected**: Extracting to a shared package — over-engineering for a temporary duplication that Wave 3 resolves.

### 3. No-Op Output Parser Initially

**Decision**: `createOutputParser()` returns a no-op parser in Phase 2.

**Rationale**: Existing callers (CliSpawner, PrFeedbackHandler, ConversationSpawner) create and manage their own `OutputCapture` instances. Until Wave 3 migrates callers to use `AgentLauncher.launch()`, the plugin's parser won't be used. Implementing a full parser now would be dead code.

**Alternative rejected**: Full stream-json parser implementation — this would duplicate `OutputCapture` logic without any caller to use it. Wave 3 can either move `OutputCapture` into the parser or adapt it.

### 4. Intent Carries All Data

**Decision**: Each intent type carries all data needed for `buildLaunch()` to compose the complete command.

**Rationale**: `buildLaunch()` is a pure, synchronous function. It cannot fetch external data (e.g., PR comments). The caller must pre-build any async data and pass it on the intent.

**Pattern**:
- Phase: prompt text is on `PhaseIntent.prompt` (composed from slash command + issue URL by caller)
- PR feedback: prompt is on `PrFeedbackIntent.prompt` (pre-built by `PrFeedbackHandler.buildFeedbackPrompt()`)
- Conversation: message is on `ConversationTurnIntent.message`

### 5. `stdioProfile` Selection

**Decision**: Phase and PR feedback intents use `"default"` profile (stdin ignored). Conversation turns use `"interactive"` profile (all stdio piped).

**Rationale**: Matches existing factory selection in the codebase:
- `CliSpawner` and `PrFeedbackHandler` use `defaultProcessFactory` (stdin ignored)
- `ConversationSpawner` uses `conversationProcessFactory` (stdin piped for PTY wrapper)

## Implementation Patterns

### Discriminated Union Extension

The Wave 1 `LaunchIntent` type is `GenericSubprocessIntent | ShellIntent`. Phase 2 extends this union:

```typescript
// In orchestrator launcher/types.ts (updated)
export type LaunchIntent = GenericSubprocessIntent | ShellIntent | ClaudeCodeIntent;

// In plugin package launch/types.ts (new)
export type ClaudeCodeIntent = PhaseIntent | PrFeedbackIntent | ConversationTurnIntent;
```

TypeScript discriminated unions are naturally additive — adding new `kind` values doesn't break existing switch/if-else handlers because they already have an `else` / `default` branch.

### Snapshot Testing Strategy

Use the Wave 1 `RecordingProcessFactory` + `normalizeSpawnRecords()` harness:

1. **Baseline capture**: Test file imports `CliSpawner`, `PrFeedbackHandler`, `ConversationSpawner` with `RecordingProcessFactory` to capture exact spawn records from the current direct-spawn code paths.
2. **Plugin capture**: Same test instantiates `ClaudeCodeLaunchPlugin`, calls `buildLaunch()` for equivalent intents, and asserts the resulting `LaunchSpec` matches.
3. **Normalization**: `normalizeSpawnRecords()` sorts env keys for deterministic comparison.

### PTY Wrapper Embedding

The Python PTY wrapper is embedded as a multiline string constant, identical to `conversation-spawner.ts`:

```typescript
const PTY_WRAPPER = [
  'import pty, os, sys',
  '# Prevent PTY line wrapping by setting huge terminal width',
  'os.environ["COLUMNS"] = "50000"',
  'def read(fd):',
  '    data = os.read(fd, 65536)',
  '    # Strip CRLF that PTY adds, return cleaned data',
  '    # (pty._copy writes our return value to stdout)',
  '    return data.replace(b"\\\\r\\\\n", b"\\\\n")',
  'pty.spawn(sys.argv[1:], read)',
].join('\n');
```

This is a verbatim copy. The wrapper forces line-buffered output from Claude CLI (which uses full buffering when writing to a pipe) and strips CRLF→LF for clean stream parsing.

## Key References

| Resource | Purpose |
|----------|---------|
| `packages/orchestrator/src/launcher/types.ts` | `AgentLaunchPlugin` interface to implement |
| `packages/orchestrator/src/worker/types.ts:73-80` | `PHASE_TO_COMMAND` map to copy |
| `packages/orchestrator/src/worker/cli-spawner.ts:37-81` | Phase spawn pattern (args construction) |
| `packages/orchestrator/src/worker/pr-feedback-handler.ts:285-315` | PR feedback spawn pattern |
| `packages/orchestrator/src/conversation/conversation-spawner.ts:47-105` | PTY wrapper + conversation spawn pattern |
| `packages/orchestrator/src/test-utils/` | Wave 1 snapshot harness (`RecordingProcessFactory`, `normalizeSpawnRecords`) |
| `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts` | Reference implementation for `AgentLaunchPlugin` |
| Wave 1 spec: `specs/425-goal-phase-1-spawn/` | Architecture decisions and type system |
| Wave 1 snapshot harness: `specs/427-goal-add-spawn-snapshot/` | Test infrastructure |
