# Research: Phase 4b — executeCommand / executeShellCommand Migration

## Technology Decisions

### 1. Module-level Registration vs. Dependency Injection

**Decision**: Module-level registration via `registerProcessLauncher()`.

**Rationale**: The dependency direction in the monorepo flows `orchestrator → workflow-engine`. Adding a reverse dependency would create a cycle. Module-level registration is a standard pattern for this scenario:
- `workflow-engine` defines `LaunchFunction` locally (no imports from `orchestrator`)
- The orchestrator calls `registerProcessLauncher()` once during boot
- `executeCommand`/`executeShellCommand` check for a registered launcher at call time

**Alternatives Considered**:
- **DI via function parameter**: Would change public API signatures — rejected per acceptance criteria
- **Shared types package**: Over-engineering for a single function type — rejected for simplicity
- **Service locator / IoC container**: No existing container in the project — rejected as too heavy

### 2. Detached Process Support

**Decision**: Extend `ProcessFactory.spawn()` options with `detached?: boolean`.

**Rationale**: The `detached: true` flag is required for process-group semantics (`process.kill(-pid, 'SIGTERM')` to kill the entire subprocess tree). This must flow from intent → plugin → launcher → factory → `child_process.spawn`.

The group-kill logic (`process.kill(-handle.pid, 'SIGTERM')`) stays in the `executeCommand`/`executeShellCommand` wrappers because:
- It's caller-specific behavior (not all `generic-subprocess` callers want group-kill)
- `ChildProcessHandle` already exposes `.pid`, so no interface changes needed
- Adding `killGroup()` to `ChildProcessHandle` would force all factory implementations to support it

### 3. Fallback Architecture

**Decision**: Direct `child_process.spawn` fallback when no launcher is registered.

**Rationale**: `@generacy-ai/workflow-engine` is published to npm. External consumers who import `executeCommand` directly never call `registerProcessLauncher()`. The fallback ensures zero breaking change:

```typescript
const launcher = getProcessLauncher();
if (launcher) {
  // AgentLauncher path (internal/orchestrator callers)
} else {
  // Direct spawn fallback (external npm consumers)
}
```

The fallback path will be allow-listed in Wave 5's lint rule (#437) with an explanatory comment.

### 4. Snapshot Testing Strategy

**Decision**: Use `RecordingProcessFactory` pattern from `orchestrator/test-utils`.

**Rationale**: The snapshot testing infrastructure established in #427 (`RecordingProcessFactory` + `normalizeSpawnRecords`) is purpose-built for verifying spawn call composition. For `workflow-engine` tests, we need a lightweight equivalent since `RecordingProcessFactory` lives in the `orchestrator` package.

Options:
- **Inline recording in test**: Define a minimal recording mock directly in the test file. This avoids a cross-package test dependency and keeps the test self-contained.
- **Import from orchestrator test-utils**: Would create a test dependency that doesn't exist today.

**Decision**: Inline the recording mock in the `workflow-engine` test. It's ~20 lines and avoids coupling.

## Implementation Patterns

### LaunchFunction Type

```typescript
export interface LaunchFunctionResult {
  process: {
    stdout: NodeJS.ReadableStream | null;
    stderr: NodeJS.ReadableStream | null;
    pid: number | undefined;
    kill(signal?: NodeJS.Signals): boolean;
    exitPromise: Promise<number | null>;
  };
}

export type LaunchFunction = (request: {
  kind: 'generic-subprocess' | 'shell';
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  detached?: boolean;
}) => LaunchFunctionResult;
```

This type is self-contained — no imports from `orchestrator`. The orchestrator's registration adapter maps this to `AgentLauncher.launch()`.

### Wrapper Refactoring Pattern

The refactored `executeCommand` will:
1. Check for registered launcher
2. If registered: build request, call launcher, get handle
3. If not registered: direct `child_process.spawn` (existing code)
4. In both paths: attach identical StringDecoder + callback + timeout + abort + group-kill logic to the process handle's streams

This means the stream processing and lifecycle management code is shared between both paths — only the spawn mechanism differs.

## Key Sources

- Spawn refactor plan: `tetrad-development/docs/spawn-refactor-plan.md`
- AgentLauncher (Phase 1, #425): `packages/orchestrator/src/launcher/agent-launcher.ts`
- Snapshot testing (#427): `packages/orchestrator/src/test-utils/recording-process-factory.ts`
- Clarification answers: `specs/430-goal-phase-4b-spawn/clarifications.md`
