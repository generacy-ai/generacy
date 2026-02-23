# Research Notes: Real-time Workflow Log Streaming

## Node.js StringDecoder for UTF-8 Safety

The `string_decoder` module is built into Node.js and handles multi-byte UTF-8 characters that span across Buffer chunk boundaries. When `stdout.on('data')` fires, the Buffer may split a multi-byte character (e.g., emoji, CJK characters) between two chunks.

**Without StringDecoder**: `data.toString()` produces replacement characters (U+FFFD) or garbled output at chunk boundaries.

**With StringDecoder**: `decoder.write(buffer)` returns only complete characters, holding incomplete bytes internally until the next `write()` call. `decoder.end()` flushes remaining bytes.

```typescript
import { StringDecoder } from 'node:string_decoder';
const decoder = new StringDecoder('utf8');

// Buffer splits a 3-byte character across chunks:
const chunk1 = Buffer.from([0xE4, 0xB8]); // First 2 bytes of '中'
const chunk2 = Buffer.from([0xAD]);         // Last byte of '中'

decoder.write(chunk1); // Returns '' (holding incomplete char)
decoder.write(chunk2); // Returns '中' (complete character)
```

**Impact**: Negligible performance overhead. Single import, no external dependencies.

## Time-based Batching vs Per-chunk vs Line-buffered

### Per-chunk (rejected)
- `stdout.on('data')` fires per OS buffer (typically 4-64KB)
- A 5-minute Claude invocation can produce thousands of chunks
- With RingBuffer capacity of 1000 and EventBus default of 1000, early events evicted within seconds
- Network overhead: one HTTP POST per chunk

### Line-buffered (rejected)
- Cleaner semantically, but adds complexity:
  - Need to handle partial lines (last chunk may not end with `\n`)
  - Binary-like output (rare but possible) has no lines
  - Need a separate "remainder" buffer for incomplete lines
- Claude's JSON output mode produces large JSON blobs without intermediate newlines

### Time-batched at 200ms (chosen)
- ~5 events/second maximum per stream (stdout + stderr = ~10/sec)
- ~300 events/minute → a 5-minute invocation produces ~1,500 events
- Well within LogBuffer's 10,000 capacity
- Latency imperceptible for a log viewer UI
- Simple implementation: append to string buffer, flush on timer

## EventBus Log Routing Strategy

The existing `EventBus.publish()` stores all events in a per-job `RingBuffer<JobEvent>` (default 1000 capacity) and broadcasts via SSE. For log events, this creates two problems:

1. **Capacity**: Log events would fill the 1000-slot buffer in seconds, evicting lifecycle events
2. **Replay**: Reconnecting clients need lifecycle history but may not need all log history

**Solution**: Route `log:append` events to a separate `LogBufferManager` (10,000 capacity per job) while still broadcasting them via SSE. Lifecycle events continue to use the existing `RingBuffer`.

This means:
- **SSE live stream** (`GET /api/jobs/:jobId/events`): Receives ALL events including `log:append` — for real-time monitoring
- **EventBus replay** (on reconnect via `Last-Event-ID`): Only replays lifecycle events — log events are not in the RingBuffer
- **Log retrieval** (`GET /api/jobs/:jobId/logs`): Dedicated endpoint reads from `LogBuffer` — supports `?since=` for incremental fetch

Trade-off: A reconnecting SSE client that missed some `log:append` events during disconnection must use `GET /api/jobs/:jobId/logs?since=<lastId>` to backfill. This is acceptable because:
- The existing SSE `/events` endpoint continues to work for live streaming
- Log history retrieval is a different access pattern from event replay
- The UI can combine both: SSE for live, REST for backfill

## AsyncEventQueue Design

The worker (JobHandler) posts events to the orchestrator via HTTP. Key constraints:

1. **Never block Claude process execution**: If the orchestrator is slow or down, logging must not slow the actual work
2. **Bounded memory**: Can't buffer unlimited events if orchestrator is unreachable
3. **No retries with backoff**: This is telemetry, not critical data. Retries with exponential backoff would add latency and complexity for non-critical data

**Design**: Simple array-based queue with bounded capacity (100). `push()` is synchronous — it appends to the array and kicks off `processQueue()` if not already running. `processQueue()` is async, drains items one at a time, silently catches errors. On overflow, `shift()` drops the oldest event.

Why 100 capacity: At 200ms batching (~5 events/sec), 100 items ≈ 20 seconds of buffer. Enough to absorb a brief network hiccup. If the orchestrator is down longer, graceful degradation via drop is acceptable.

## Existing Infrastructure Reuse

Several decisions leverage existing infrastructure:

| Component | Existing | Reuse |
|-----------|----------|-------|
| `RingBuffer` | `event-bus.ts` | LogBuffer wraps `RingBuffer<LogEntry>` |
| `EventBus.publish()` | `event-bus.ts` | SSE broadcast for log events (passthrough, not stored in RingBuffer) |
| `POST /api/jobs/:jobId/events` | `server.ts` | Ingestion path for `log:append` events |
| `OrchestratorClient.publishEvent()` | `client.ts` | Worker-to-orchestrator event posting |
| SSE headers + heartbeat | `server.ts` / `event-bus.ts` | Reused for `GET /logs?stream=true` |
| Cleanup timers | `EventBus.scheduleCleanup()` | Pattern replicated in `LogBufferManager` |

## Forward Compatibility with Parent Epic #175

This feature is Part of #175 (Real-time workflow monitoring). The architecture supports:

- **Future structured parsing**: The `log:append` event data can be extended with parsed tool call information (file reads, edits, bash commands) without breaking existing consumers
- **Future UI components**: The `GET /api/jobs/:jobId/logs` endpoint with `?stream=true` provides a clean API for a log viewer component
- **Future per-task grouping**: The `taskIndex` and `taskTitle` fields in implement step logs enable per-task output collapsing in a monitoring UI
- **Future log persistence**: The `LogBuffer` abstraction can be backed by a persistent store (e.g., Redis, SQLite) in a future iteration without changing the API contract
