# Feature Specification: Capture and Stream Claude Conversation Output to Orchestrator

**Branch**: `178-parent-epic-part-175` | **Date**: 2026-02-23 | **Status**: Draft
**Parent Epic**: #175 — Real-time workflow monitoring

## Summary

Add real-time stdout/stderr streaming from `claude -p` processes spawned by the workflow engine to the orchestrator, enabling live monitoring of AI conversation output from the extension. Currently, `executeCommand()` in `cli-utils.ts` buffers all output until process completion. This feature adds streaming callbacks to capture output chunks as they arrive and forwards them as `log:append` events through the orchestrator's existing EventBus/SSE infrastructure.

## Current State

- **`executeCommand()`** (`packages/workflow-engine/src/actions/cli-utils.ts`) uses `spawn()` with piped stdout/stderr but concatenates output into strings, only returning them on process close.
- **Speckit operations** (`packages/workflow-engine/src/actions/builtin/speckit/operations/*.ts`) call `executeCommand()` with `{ cwd, timeout, signal }` and process the full result after completion.
- **ActionContext** (`packages/workflow-engine/src/types/action.ts`) has `logger` and `signal` but no event publishing mechanism for streaming data back to the orchestrator.
- **Orchestrator** (`packages/generacy/src/orchestrator/server.ts`) already has a robust EventBus with RingBuffer, SSE subscriber management, and `log:append` is already a valid event type. The `POST /api/jobs/:jobId/events` endpoint exists and can receive events.
- **Workflow engine** has an internal `ExecutionEventEmitter` but it only broadcasts to local listeners — not connected to the orchestrator's EventBus.

## User Stories

### US1: Real-Time Claude Output Monitoring

**As a** developer using Generacy,
**I want** to see the claude AI conversation output streaming in real-time while a workflow step executes,
**So that** I can monitor progress, debug issues, and understand what the AI is doing without waiting for the entire operation to complete.

**Acceptance Criteria**:
- [ ] stdout/stderr from `claude -p` processes appear in the UI within 1 second of being produced
- [ ] Output is attributed to the correct step name (specify, plan, tasks, implement)
- [ ] Streams are labeled as stdout or stderr
- [ ] Output continues to stream even for long-running operations (10+ minutes)

### US2: Log History Retrieval

**As a** developer joining a workflow already in progress,
**I want** to retrieve the log output that has already been produced,
**So that** I can catch up on what has happened without needing to have been connected from the start.

**Acceptance Criteria**:
- [ ] `GET /api/jobs/:jobId/logs` returns buffered log entries
- [ ] Incremental fetching via `?since=<eventId>` returns only new entries
- [ ] Buffer contains a reasonable history (last 10,000 lines)
- [ ] Logs are cleaned up after job completion to prevent memory leaks

### US3: SSE Log Streaming

**As a** frontend client,
**I want** to subscribe to a real-time log stream via SSE,
**So that** I can display live output without polling.

**Acceptance Criteria**:
- [ ] SSE subscribers receive `log:append` events as they arrive
- [ ] Reconnecting with `Last-Event-ID` replays missed events
- [ ] SSE heartbeats keep the connection alive during quiet periods

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `onStdout` and `onStderr` optional callbacks to `CommandOptions` interface | P1 | Non-breaking change to existing interface |
| FR-002 | Wire callbacks to spawn process `stdout.on('data')` and `stderr.on('data')` events in `executeCommand()` | P1 | Callbacks fire in addition to existing string accumulation |
| FR-003 | Add `onStdout`/`onStderr` to `executeShellCommand()` the same way | P2 | Same pattern, ensures consistency |
| FR-004 | Add `emitEvent` method to `ActionContext` interface | P1 | `emitEvent?: (event: { type: string; data: Record<string, unknown> }) => void` |
| FR-005 | Pass `emitEvent` into `ActionContext` from `WorkflowExecutor` during step execution | P1 | Bridge internal event emitter to context |
| FR-006 | Update speckit operations to pass `onStdout`/`onStderr` callbacks that call `context.emitEvent` with `step:output` events | P1 | Each operation: clarify, specify, plan, tasks, implement |
| FR-007 | Create `LogBuffer` class as a per-job ring buffer for log entries | P1 | New file: `packages/generacy/src/orchestrator/log-buffer.ts` |
| FR-008 | Add `POST /api/jobs/:jobId/logs` endpoint to append log chunks and broadcast via SSE | P1 | Reuse existing EventBus for broadcast |
| FR-009 | Add `GET /api/jobs/:jobId/logs` endpoint with `?since=<eventId>` and `?stream=true` support | P1 | Returns JSON array or opens SSE stream |
| FR-010 | Clean up log buffers when jobs reach terminal states (complete, failed, cancelled) | P2 | Prevent memory leaks; use grace period before cleanup |
| FR-011 | Include `stepName` in log entries to identify which operation produced the output | P2 | Aids filtering and debugging |
| FR-012 | Worker posts `log:append` events to orchestrator via existing `POST /api/jobs/:jobId/events` endpoint | P1 | Uses existing HTTP event posting infrastructure |

## Technical Design

### 1. cli-utils.ts Changes

```typescript
export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;  // NEW
  onStderr?: (chunk: string) => void;  // NEW
}
```

In `executeCommand()`, add callback invocations alongside existing buffering:

```typescript
proc.stdout.on('data', (data: Buffer) => {
  const text = data.toString();
  stdout += text;
  options.onStdout?.(text);  // NEW
});

proc.stderr.on('data', (data: Buffer) => {
  const text = data.toString();
  stderr += text;
  options.onStderr?.(text);  // NEW
});
```

### 2. ActionContext Extension

```typescript
export interface ActionContext {
  // ... existing fields
  emitEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
}
```

### 3. Speckit Operation Integration

Each operation passes streaming callbacks:

```typescript
const result = await executeCommand('claude', args, {
  cwd: input.feature_dir,
  timeout,
  signal: context.signal,
  onStdout: (chunk) => {
    context.emitEvent?.({
      type: 'step:output',
      data: { stream: 'stdout', content: chunk, stepName: 'specify' }
    });
  },
  onStderr: (chunk) => {
    context.emitEvent?.({
      type: 'step:output',
      data: { stream: 'stderr', content: chunk, stepName: 'specify' }
    });
  },
});
```

### 4. LogBuffer (New File)

```typescript
// packages/generacy/src/orchestrator/log-buffer.ts
export interface LogEntry {
  id: string;
  timestamp: number;
  stream: 'stdout' | 'stderr';
  stepName: string;
  content: string;
}

export class LogBuffer {
  // Ring buffer with configurable capacity (default: 10,000 entries)
  // Methods: append(), getAll(), getSince(eventId), clear()
}
```

### 5. Log Endpoints

**`POST /api/jobs/:jobId/logs`** — Append log chunk:
- Request body: `{ stream, stepName, content }`
- Assigns timestamp and monotonic ID
- Appends to per-job LogBuffer
- Broadcasts as `log:append` event to SSE subscribers

**`GET /api/jobs/:jobId/logs`** — Retrieve logs:
- Default: Returns JSON array of all buffered log entries
- `?since=<eventId>`: Returns entries after the given ID
- `?stream=true`: Opens SSE connection for live streaming

### 6. Log Entry Wire Format

```json
{
  "id": "42",
  "timestamp": 1234567890123,
  "stream": "stdout",
  "stepName": "specify",
  "content": "Reading extension/src/extension.ts...\n"
}
```

### 7. Event Flow

```
claude process
    │ stdout chunk
    ▼
executeCommand() onStdout callback
    │
    ▼
context.emitEvent({ type: 'step:output', data: {...} })
    │
    ▼
Worker HTTP POST → POST /api/jobs/:jobId/events
    │
    ▼
EventBus.publish() → RingBuffer + SSE broadcast
    │
    ▼
Frontend SSE subscriber receives log:append event
```

## Files to Modify

| File | Change |
|------|--------|
| `packages/workflow-engine/src/actions/cli-utils.ts` | Add `onStdout`/`onStderr` to `CommandOptions`; wire to spawn data events |
| `packages/workflow-engine/src/types/action.ts` | Add optional `emitEvent` to `ActionContext` |
| `packages/workflow-engine/src/executor/index.ts` | Pass `emitEvent` into `ActionContext` during step execution |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` | Add streaming callbacks |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/specify.ts` | Add streaming callbacks |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts` | Add streaming callbacks |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/tasks.ts` | Add streaming callbacks |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts` | Add streaming callbacks |
| `packages/generacy/src/orchestrator/server.ts` | Add `POST` and `GET /api/jobs/:jobId/logs` routes |
| `packages/generacy/src/orchestrator/log-buffer.ts` | **New file** — Per-job log ring buffer |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Output latency | < 1 second from process stdout to SSE delivery | Timestamp diff between chunk production and SSE receipt |
| SC-002 | Log buffer memory | < 50 MB per job | Monitor buffer size for typical workflow runs |
| SC-003 | SSE reconnection | No data loss on reconnect | Verify `?since=` returns all missed entries |
| SC-004 | Long-running stability | Streams remain active for 30+ minute operations | Test with extended claude invocations |
| SC-005 | Cleanup reliability | Log buffers freed within 60s of job terminal state | Monitor memory after job completion |

## Assumptions

- The worker process has HTTP connectivity to the orchestrator to post events (existing assumption for the current event system).
- The existing `POST /api/jobs/:jobId/events` endpoint and EventBus can handle the increased event volume from streaming output (stdout can produce many chunks per second).
- Claude process stdout produces UTF-8 text that can be safely chunked at arbitrary Buffer boundaries (may split multi-byte characters; this is acceptable for logging purposes).
- The `emitEvent` bridge from `WorkflowExecutor` to the orchestrator will use the same HTTP posting mechanism already used for other workflow events.
- SSE clients (the extension frontend) already have infrastructure to connect to the orchestrator's SSE endpoints.

## Out of Scope

- **Parsing Claude's JSON output** for structured tool call extraction — this spec covers raw text streaming only. Structured parsing can be layered on top in a future feature.
- **Frontend UI components** for displaying log output — covered by separate specs in the monitoring epic.
- **Log persistence to disk or database** — logs are kept in-memory ring buffers only. Persistent storage is a separate concern.
- **Rate limiting or throttling** of log events — if this becomes necessary due to volume, it will be addressed as a follow-up.
- **Stderr-specific error handling** — stderr chunks are captured and streamed but not parsed for error detection or alerting.
- **Multi-worker log aggregation** — this spec assumes a single worker per job. Multi-worker support is out of scope.

---

*Generated by speckit*
