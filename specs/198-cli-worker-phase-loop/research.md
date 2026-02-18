# Research: Claude CLI Worker with Phase Loop

## Technology Decisions

### 1. Process Spawning: `node:child_process.spawn` (not exec)

**Decision**: Use `spawn` with stdio pipes for the Claude CLI process.

**Rationale**:
- `spawn` streams stdout/stderr in real-time (needed for SSE streaming and output capture)
- `exec` buffers all output until completion (unsuitable for long-running phases)
- The existing `Invoker` class in `generacy-plugin-claude-code` uses `ContainerManager.exec()` which runs in Docker containers — the worker operates on bare metal, so we need direct `spawn`
- `spawn` provides the `ChildProcess` object for signal handling (SIGTERM/SIGKILL)

**Alternatives considered**:
- `execFile`: Similar buffering issue as exec
- Reusing `Invoker` class: Requires Docker container infrastructure; worker needs lighter weight direct process spawning
- `execa` (npm package): Unnecessary dependency; `node:child_process` is sufficient

### 2. Output Parsing: Line-delimited JSON from stdout

**Decision**: Parse Claude CLI's `--output json --print all` output as newline-delimited JSON.

**Rationale**:
- Claude CLI with `--output json` emits structured JSON events (one per line)
- The existing `OutputParser` in `generacy-plugin-claude-code/src/streaming/output-parser.ts` handles this format
- We can reuse the parsing pattern but implement it inline since we don't need the full plugin dependency

**Event types expected**:
- `init` — session started
- `tool_use` — tool invocation
- `tool_result` — tool completion
- `text` — assistant text output
- `complete` — invocation finished
- `error` — error occurred

### 3. Label Operations: Direct GitHub REST API via Octokit

**Decision**: Use `createGitHubClient()` from `@generacy-ai/workflow-engine` for all GitHub operations.

**Rationale**:
- Already used by `LabelMonitorService` for the same repository operations
- Provides typed Octokit instance with authentication
- Retry logic wraps around individual API calls in the worker's `LabelManager`

### 4. Stage Comments: HTML Marker Pattern

**Decision**: Use `<!-- generacy-stage:X -->` HTML comments as markers to find and update stage comments.

**Rationale**:
- Already established pattern in the autodev workflow (confirmed by existing stage comments on issue #198)
- GitHub renders HTML comments as invisible, so markers don't clutter the UI
- Reliable: search issue comments for marker, update or create as needed

### 5. Gate Configuration: Zod Schema in DispatchConfig

**Decision**: Extend the orchestrator's existing Zod config schema with gate definitions per workflow type.

**Rationale**:
- The config system already uses Zod for validation (`OrchestratorConfigSchema`)
- Gate definitions are simple: `{ phase, gateLabelName, condition }` per workflow type
- Environment variable overrides work naturally through the existing config loader
- Default gates are baked into the schema defaults

### 6. Per-Worker Checkout: Isolated by Worker ID

**Decision**: `{WORKSPACE_DIR}/{workerId}/{owner}/{repo}` checkout path.

**Rationale**:
- `WorkerDispatcher` generates `workerId` as UUID per claimed item
- Avoids race conditions with concurrent workers on same repo
- Cleanup is bounded: worker can remove its checkout directory on completion
- Alternative (per-repo mutex) would reduce parallelism unnecessarily

## Implementation Patterns

### Composition over Inheritance
The `ClaudeCliWorker` composes sub-components rather than inheriting from a base class. Each sub-component is independently testable:
- `PhaseResolver` — pure function: labels → phase
- `LabelManager` — thin wrapper over Octokit label API
- `StageCommentManager` — thin wrapper over Octokit comment API
- `GateChecker` — pure function: phase + config → gate or null
- `CliSpawner` — injectable process factory for testing

### Process Factory Injection
```typescript
type ProcessFactory = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
```
The `CliSpawner` accepts a `ProcessFactory` parameter. In production, this is `child_process.spawn`. In tests, it returns a mock `ChildProcess` with controllable stdout/stderr/exit events.

### Bounded Execution with AbortController
Following the same pattern as `WorkerDispatcher` and `LabelMonitorService`:
- Each phase execution gets an `AbortController` with a timeout
- The abort signal propagates to process kill on timeout
- Cleanup runs in `finally` blocks to ensure label state consistency

## Key Sources

| Source | Relevance |
|--------|-----------|
| `packages/orchestrator/src/services/worker-dispatcher.ts` | Integration contract (WorkerHandler type, heartbeat, retry) |
| `packages/orchestrator/src/server.ts:152-158` | Placeholder handler to replace |
| `packages/orchestrator/src/types/monitor.ts` | QueueItem, WorkerHandler interfaces |
| `packages/workflow-engine/src/actions/github/label-definitions.ts` | WORKFLOW_LABELS constants |
| `packages/generacy-plugin-claude-code/src/invocation/invoker.ts` | Existing CLI invocation patterns |
| `packages/orchestrator/src/sse/events.ts` | SSE event creation helpers |
| `packages/orchestrator/src/config/schema.ts` | Config schema extension point |
| label-protocol.md (tetrad-development) | Workflow lifecycle and label transitions |

---

*Generated by speckit*
