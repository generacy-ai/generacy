# Research: Consolidate root-level claude-code-invoker

## Technology Decisions

### 1. Extend ClaudeCodeLaunchPlugin vs. New Plugin

**Decision**: Add the `invoke` intent kind to the existing `ClaudeCodeLaunchPlugin` rather than creating a separate plugin.

**Rationale**: The plugin already owns all Claude CLI intent kinds (`phase`, `pr-feedback`, `conversation-turn`). The `invoke` kind produces the same executable (`claude`) with different flags. A separate plugin would fragment Claude CLI launch logic across two plugins with no benefit. This follows the pattern established in #425 Q3 answer C — additive union member.

**Alternatives Considered**:
- **Separate `InvokePlugin`**: Cleaner isolation, but splits Claude CLI ownership. Would require a new `pluginId`, complicating plugin lookup. Rejected.
- **GenericSubprocessPlugin with pre-built args**: Would work mechanically, but loses semantic clarity — `invoke` is a Claude-specific intent, not a generic subprocess. Rejected.

### 2. Environment Variable Strategy

**Decision**: Pass `config.context.environment` (plus `CLAUDE_MODE` if set) as `request.env` in the `LaunchRequest`. Do NOT set `intent.env`.

**Rationale**: `AgentLauncher.launch()` performs a 3-layer merge: `{ ...process.env, ...pluginEnv, ...callerEnv }`. For the `invoke` intent, `ClaudeCodeLaunchPlugin.buildLaunch()` returns no `env` in the `LaunchSpec` (pluginEnv is undefined). Therefore the merge collapses to `{ ...process.env, ...callerEnv }`, which is byte-identical to the current `buildEnvironment()` output:
```typescript
// Current
const env = { ...process.env, ...config.context.environment };
if (config.context.mode) env.CLAUDE_MODE = config.context.mode;

// After migration — same result via launcher merge
request.env = { ...config.context.environment, ...(mode ? { CLAUDE_MODE: mode } : {}) };
```

### 3. Stream Collection: Adapter vs. Plugin OutputParser

**Decision**: Adapter collects stdout/stderr directly from `LaunchHandle.process` streams. Plugin's `createOutputParser()` returns no-op for `invoke` intent.

**Rationale**: The adapter must build `InvocationResult` with `output` (combined stdout+stderr), `toolCalls` (parsed from stdout), `exitCode`, `duration`, and `error`. These are all adapter-level concerns. The `OutputParser` interface (`processChunk`/`flush`) doesn't have a mechanism to produce `InvocationResult` — it's designed for streaming parsing, not result aggregation. Keeping collection in the adapter is the minimal-change path.

### 4. Timeout Mechanism: setTimeout vs. AbortSignal

**Decision**: Use `setTimeout` + `handle.process.kill('SIGTERM')`, matching the current implementation.

**Rationale**: The current code uses `setTimeout(() => { killed = true; child.kill('SIGTERM') }, config.timeout)`. `AbortSignal` integration would require changes to `LaunchHandle`'s lifecycle management and error propagation — scope creep for this phase. The `setTimeout` + `kill` approach is well-tested and behavior-preserving. Per clarification Q5 answer B.

**Future consideration**: Wave 3 may standardize on `AbortSignal` across all launch consumers.

### 5. isAvailable() via generic-subprocess Intent

**Decision**: Route `isAvailable()` through `AgentLauncher.launch()` using `{ kind: 'generic-subprocess', command: 'claude', args: ['--version'] }`.

**Rationale**: Satisfies the "no `child_process` import in `src/agents/`" acceptance criterion. The `GenericSubprocessPlugin` handles this intent with the `default` stdio profile (`['ignore', 'pipe', 'pipe']`), matching the current `isAvailable()` spawn. `exitPromise` resolves with exit code 0 on success — same logic as current `child.on('close', code => resolve(code === 0))`.

Per clarification Q4 answer.

### 6. ProcessFactory Sourcing in Root Worker

**Decision**: Import `createAgentLauncher()` from `@generacy-ai/orchestrator` after adding it as a workspace dependency.

**Rationale**: `createAgentLauncher()` already registers `GenericSubprocessPlugin` and `ClaudeCodeLaunchPlugin` with the correct factory map. Reusing it avoids duplicating plugin registration logic. Per clarification Q2 answer.

The root worker needs both `default` and `interactive` ProcessFactory instances. These are the same factories used by the orchestrator's `ClaudeCliWorker`. The workspace dependency makes them importable.

## Implementation Patterns

### Adapter Pattern

`ClaudeCodeInvoker` becomes a classic adapter:
- Accepts `InvocationConfig` (the `AgentInvoker` interface)
- Translates to `LaunchRequest` (the `AgentLauncher` interface)
- Collects output from `LaunchHandle` and translates back to `InvocationResult`

This is intentionally a thin layer — no business logic, just shape translation.

### Mock LaunchHandle for Testing

Adapter tests mock `AgentLauncher.launch()` to return a `LaunchHandle` with:
- `process.stdout` / `process.stderr`: `EventEmitter` instances that emit `data` events
- `process.exitPromise`: `Promise.resolve(exitCode)`
- `process.kill()`: `vi.fn()`
- `outputParser`: no-op
- `metadata`: `{ pluginId: 'claude-code', intentKind: 'invoke' }`

This isolates adapter logic from plugin and factory internals.

## Key Sources

- Spawn refactor plan: `tetrad-development/docs/spawn-refactor-plan.md` Phase 5
- AgentLauncher: `packages/orchestrator/src/launcher/agent-launcher.ts`
- ClaudeCodeLaunchPlugin: `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`
- Plugin types: `packages/generacy-plugin-claude-code/src/launch/types.ts`
- ProcessFactory types: `packages/orchestrator/src/worker/types.ts:257-281`
- Launcher setup: `packages/orchestrator/src/launcher/launcher-setup.ts`
- Reference adapter pattern: `specs/429-goal-phase-4a-spawn/` (SubprocessAgency migration)
- Clarifications: `specs/436-goal-phase-5-spawn/clarifications.md`
