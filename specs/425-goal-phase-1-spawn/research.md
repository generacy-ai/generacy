# Research: AgentLauncher + GenericSubprocessPlugin (Phase 1)

**Feature**: #425 | **Date**: 2026-04-12

## Technology Decisions

### 1. Plugin Resolution Strategy

**Decision**: Plugins declare a `supportedKinds: string[]` array; the launcher builds an internal `kind → plugin` map at registration time.

**Alternatives considered**:
- **A: `pluginId` matches `intent.kind` 1:1** — Rejected because `GenericSubprocessPlugin` needs to handle two kinds (`generic-subprocess` and `shell`). Would require two separate plugin instances for the same logic.
- **B: Plugin receives all intents, returns `null` if unsupported** — Rejected because it requires iterating all plugins per launch (O(n) instead of O(1) lookup).
- **C: Plugin declares `supportedKinds` array** — Selected. O(1) lookup via pre-built map, supports multi-kind plugins naturally, and throws immediately on duplicate kind registration.

### 2. Environment Merge Strategy

**Decision**: `AgentLauncher` performs 3-layer merge (`process.env ← plugin env ← caller env`), passes fully-merged result to `ProcessFactory.spawn()`.

**Alternatives considered**:
- **A: Launcher merges, factories stop merging** — Per clarification Q4 answer, but breaks "zero caller changes" constraint since existing callers (`CliSpawner`, `ConversationSpawner`) rely on factory's `{ ...process.env, ...options.env }` merge.
- **B: Launcher passes only plugin+caller env, factory adds process.env** — Status quo for factories, but inconsistent merge semantics between launcher path and direct-factory path.
- **C: Launcher includes process.env in merge, factories unchanged** — Selected. The factory's existing `{ ...process.env, ...options.env }` merge is idempotent when `options.env` already contains `process.env`. Zero behavioral change for existing callers. Factory cleanup deferred to Wave 2+ caller migrations.

### 3. ProcessFactory Selection

**Decision**: `AgentLauncher` holds a `Map<string, ProcessFactory>` keyed by stdio profile name. `LaunchSpec.stdioProfile` (default: `"default"`) selects the factory.

**Rationale**: Per clarification Q1. The two existing factories differ only in stdio configuration (`['ignore', 'pipe', 'pipe']` vs `['pipe', 'pipe', 'pipe']`). Rather than adding stdio params to `ProcessFactory.spawn()` (breaking change), or making it metadata-only (useless), we map profile names to factory instances. This matches the existing architecture naturally — `conversationProcessFactory` exists solely because interactive use needs stdin piped.

**Phase 1 profiles**:
- `"default"` → `defaultProcessFactory` (stdin ignored)
- `"interactive"` → `conversationProcessFactory` (stdin piped)

### 4. OutputParser Interface

**Decision**: Stateful processor with `processChunk(stream: 'stdout' | 'stderr', data: string): void` and `flush(): void`.

**Rationale**: Per clarification Q2. Aligns with existing `OutputCapture.processChunk()` and `ConversationOutputParser` patterns. The `stream` discriminator is a minor extension that lets parsers distinguish stdout from stderr. String-typed (not Buffer) because existing parsers already decode to string.

### 5. LaunchHandle Design

**Decision**: Thin wrapper exposing `process: ChildProcessHandle`, `outputParser: OutputParser`, and `metadata: Record<string, unknown>`.

**Rationale**: Per clarification Q5. No lifecycle ownership — callers continue to implement their own SIGTERM → grace → SIGKILL shutdown logic. Lifecycle consolidation belongs in Wave 3 when callers are migrated. The `metadata` field allows plugins to attach arbitrary data (e.g., session IDs, plugin-specific state) without changing the `LaunchHandle` type.

### 6. Module Location

**Decision**: New `packages/orchestrator/src/launcher/` directory.

**Alternatives considered**:
- **A: Inside `src/worker/`** — Rejected; the launcher is not worker-specific (conversations will also use it in Wave 2+).
- **B: Inside `src/lib/` or `src/utils/`** — Rejected; the launcher is a first-class domain concept, not a utility.
- **C: New `src/launcher/` directory** — Selected. Clean separation, co-locates types + implementation + plugin + tests.

## Implementation Patterns

### Registry Pattern

The plugin registry uses a simple `Map` with eager validation:

```typescript
registerPlugin(plugin: AgentLaunchPlugin): void {
  for (const kind of plugin.supportedKinds) {
    if (this.kindToPlugin.has(kind)) {
      throw new Error(`Intent kind "${kind}" already registered by plugin "${this.kindToPlugin.get(kind)!.pluginId}"`);
    }
    this.kindToPlugin.set(kind, plugin);
  }
}
```

This prevents silent override of existing registrations and provides clear error messages.

### Testing Strategy

- **Unit tests**: Mock `ProcessFactory` and `AgentLaunchPlugin` to test launcher logic in isolation
- **Snapshot tests**: Call `GenericSubprocessPlugin.buildLaunch()` with known inputs and snapshot the `LaunchSpec` output
- **No integration tests**: Phase 1 has no callers exercising the launcher in production code paths; integration testing happens in Wave 2+

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Unknown intent kind | Throw `Error` with message listing the kind and available registered kinds |
| Unknown stdio profile | Throw `Error` with message listing the profile and available profiles |
| Duplicate kind registration | Throw `Error` at registration time (not at launch time) |
| Plugin `buildLaunch()` throws | Propagate to caller (no wrapping) |

## Key References

- [Spawn refactor plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md) — Parent design document
- `ProcessFactory` interface: `packages/orchestrator/src/worker/types.ts:269`
- `ChildProcessHandle` interface: `packages/orchestrator/src/worker/types.ts:280`
- `defaultProcessFactory`: `packages/orchestrator/src/worker/claude-cli-worker.ts:25`
- `conversationProcessFactory`: `packages/orchestrator/src/conversation/process-factory.ts:10`
- `OutputCapture`: `packages/orchestrator/src/worker/output-capture.ts`
- `ConversationOutputParser`: `packages/orchestrator/src/conversation/output-parser.ts`
