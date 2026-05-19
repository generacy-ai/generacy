# Research: Migrate SubprocessAgency to AgentLauncher

## Technology Decisions

### 1. Injection Strategy: Second Constructor Parameter

**Decision**: Inject `AgentLauncher` as an optional second constructor parameter rather than adding it to `SubprocessAgencyOptions`.

**Rationale**: `SubprocessAgencyOptions` is a public type re-exported from `@generacy-ai/generacy` and consumed by `cluster-base` and `cluster-microservices`. Any change (even adding an optional field) is technically a type signature change. A second parameter preserves the exact type while keeping injection explicit and testable.

**Alternatives Considered**:
- **Add to options**: Simpler, but changes the public type. Rejected per spec constraint.
- **Module-level setter**: `SubprocessAgency.setLauncher(launcher)`. Global state, harder to test, not idiomatic. Rejected.
- **Factory injection via `createAgencyConnection`**: Would require changing `AgencyConnectionOptions` too. Rejected — wider blast radius.

### 2. Process Handle Unification

**Decision**: Use a minimal internal `ProcessHandle` type that covers the intersection of `ChildProcess` and `ChildProcessHandle`.

**Rationale**: After migration, `SubprocessAgency` may hold either a `ChildProcess` (fallback path) or `ChildProcessHandle` (launcher path). Both share `stdin`, `stdout`, `stderr`, and `kill()`. The internal type abstracts over the difference without exposing it publicly.

```typescript
// Internal only — not exported
interface ProcessHandle {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}
```

### 3. Stdio Profile: 'interactive'

**Decision**: Use `stdioProfile: 'interactive'` in the launch intent.

**Rationale**: The `'interactive'` profile selects `conversationProcessFactory` which spawns with `['pipe', 'pipe', 'pipe']` — exactly matching `SubprocessAgency`'s current hardcoded stdio. The `'default'` profile uses `['ignore', 'pipe', 'pipe']` which would break stdin writes.

**Source**: Established in #425 Q1 (answer C). The AgentLauncher in `claude-cli-worker.ts:106-112` already registers both `'default'` and `'interactive'` factories.

### 4. Env Merge Parity

**Decision**: Set `intent.env = undefined` (omit from intent), pass `this.env` as `request.env`.

**Rationale**: AgentLauncher performs 3-layer merge: `{ ...process.env, ...pluginEnv, ...callerEnv }`. GenericSubprocessPlugin returns no env additions (plugin env is undefined). So the merge collapses to `{ ...process.env, ...callerEnv }` which is byte-identical to the current `{ ...process.env, ...this.env }`.

**Verification**: Snapshot test with `RecordingProcessFactory` will assert env parity.

### 5. Error Handling via exitPromise

**Decision**: Use `ChildProcessHandle.exitPromise` rejection for spawn errors instead of `process.on('error')`.

**Rationale**: `ChildProcessHandle` doesn't extend EventEmitter — it exposes `exitPromise` instead. Per #426, `exitPromise` will reject with the spawn error (e.g., ENOENT) rather than resolving with code 1. This preserves the immediate error rejection behavior.

**Dependency**: Requires #426 (ProcessFactory spawn error propagation). If #426 is not yet merged, the fallback path still provides current behavior.

### 6. Exit Handling via exitPromise

**Decision**: Wire `exitPromise.then()` for exit logging, accept loss of signal information.

**Rationale**: Current code uses `process.on('exit', (code, signal))` for logging. `exitPromise` resolves with `number | null` (code only). The signal loss is acceptable per spec — SubprocessAgency logs it but doesn't branch on it.

## Implementation Patterns

### Branched connect() Pattern

The `connect()` method will have two branches:
1. **Launcher path**: builds `LaunchRequest`, calls `agentLauncher.launch()`, wires `exitPromise`
2. **Direct path**: existing `spawn()` code with `process.on()` event handlers

Both branches converge at the shared initialization sequence (send init message, await response, set connected).

### RecordingProcessFactory for Snapshot Testing

The orchestrator package provides `RecordingProcessFactory` and `normalizeSpawnRecords()` test utilities. These capture exactly what gets passed to `ProcessFactory.spawn()` and normalize env key ordering for deterministic snapshots — perfect for verifying byte-identical spawn argument composition.

## Key Sources

- Spawn refactor plan: `tetrad-development/docs/spawn-refactor-plan.md` Phase 4
- AgentLauncher: `packages/orchestrator/src/launcher/agent-launcher.ts`
- GenericSubprocessPlugin: `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts`
- ProcessFactory types: `packages/orchestrator/src/worker/types.ts:269-293`
- ConversationProcessFactory: `packages/orchestrator/src/conversation/process-factory.ts`
- RecordingProcessFactory: `packages/orchestrator/src/test-utils/recording-process-factory.ts`
- Clarifications: `specs/429-goal-phase-4a-spawn/clarifications.md`
