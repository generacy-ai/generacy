# Research: Orchestrator Job Lifecycle Events via Relay WebSocket

## Technology Decisions

### 1. Worker-Side Relay Client (Direct Connection)

**Decision**: Each worker container creates its own `ClusterRelayClient` WebSocket connection to the cloud for event emission.

**Rationale**: The orchestrator uses a multi-process architecture where workers (job processors) and the relay bridge (cloud connector) run in separate containers. Workers need to emit events but have no access to the relay bridge.

**Alternatives Considered**:

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **Direct relay client** (chosen) | Simple, no intermediary, reuses existing `ClusterRelayClient` class | Extra WebSocket per worker | Best fit — workers already import `@generacy-ai/cluster-relay` indirectly |
| Redis pub/sub | Single relay connection, centralized | New infrastructure, latency, message format translation, subscription management | Over-engineered for event counts (max ~10 events per job) |
| Worker → orchestrator HTTP API | Reuses existing relay bridge | Couples worker to orchestrator availability, adds HTTP round-trip | Fragile — orchestrator might not be running |

### 2. Flat Event Message Format

**Decision**: Use `{ type: 'event', event: string, data: Record<string, unknown>, timestamp: string }` matching the cloud API's `EventMessage` type directly.

**Rationale**: The clarification confirmed this is what `MessageHandler.handleEvent()` parses. Using the existing `RelayEvent` structure (with `channel` and nested `SSEEvent`) would require the relay server to transform it, adding complexity.

**Risk**: The `RelayMessage` union already has `RelayEvent` with `type: 'event'`. The new `RelayJobEvent` also uses `type: 'event'`. TypeScript discriminated unions require unique discriminant values. Mitigation: use a union tag approach or keep both in the union and distinguish at runtime by checking for `channel` vs `event` properties.

### 3. UUID Generation

**Decision**: Use native `crypto.randomUUID()` (Node.js built-in).

**Rationale**: Already used extensively throughout the codebase (`WorkerDispatcher`, `ClaudeCliWorker`, `SSEStream`, `InMemoryWorkflowStore`). No external `uuid` package dependency needed.

### 4. Fire-and-Forget Event Emission

**Decision**: All event emission is non-throwing and non-blocking. Failed emissions are logged at warn level and swallowed.

**Rationale**: Job lifecycle events are observability data — they should never interrupt actual job processing. If the relay is disconnected, events are silently dropped. This matches the existing SSE emitter pattern (`this.sseEmitter?.(...)`).

## Implementation Patterns

### Callback Injection Pattern

The codebase uses callback injection extensively for cross-cutting concerns:
- `SSEEventEmitter` callback injected into `ClaudeCliWorker` and `OutputCapture`
- `ConversationManager` output callback set on `RelayBridge`
- `LabelCleanupFn` callback on `WorkerDispatcher`

Following this pattern, `JobEventEmitter` will be a callback type injected as a dependency:

```typescript
type JobEventEmitter = (event: string, data: Record<string, unknown>) => void;
```

### Event Emission Points

Mapped to existing code locations:

| Event | Location | Hook Point |
|-------|----------|------------|
| `job:created` | `ClaudeCliWorker.handle()` | After `WorkerContext` creation, before phase resolution |
| `job:phase_changed` | `PhaseLoop.executeLoop()` | Top of phase loop iteration, before `labelManager.onPhaseStart()` |
| `job:paused` | `PhaseLoop.executeLoop()` | After `labelManager.onGateHit()`, before return |
| `job:completed` | `ClaudeCliWorker.handle()` | At each existing `workflow:completed` SSE emission point |
| `job:failed` | `ClaudeCliWorker.handle()` | At each existing `workflow:failed` SSE emission point |

### Relay Client Lifecycle in Worker Mode

```
Server start → create ClusterRelayClient → connect()
                                              ↓
                              Job dequeue → emit job:created
                              Phase start → emit job:phase_changed
                              Gate hit    → emit job:paused
                              Job done    → emit job:completed/failed
                                              ↓
Server shutdown → disconnect()
```

The relay client connection persists across jobs (it's created once at server start). Individual job events include the `jobId` UUID for correlation.

## Key Sources

- **Cloud API event handler**: `generacy-cloud#228` — `services/relay/message-handler.ts` → `handleEvent()`
- **Cloud API EventMessage type**: `{ type: 'event', event: string, data: Record<string, unknown>, timestamp: string }`
- **Existing relay forwarding**: `RelayBridge.setupEventForwarding()` (`relay-bridge.ts:253-280`)
- **Existing SSE emission**: `ClaudeCliWorker.handle()` (`claude-cli-worker.ts:126-136`)
- **Phase loop lifecycle**: `PhaseLoop.executeLoop()` (`phase-loop.ts:68-485`)
- **Gate mechanism**: `GateChecker.checkGate()` (`gate-checker.ts`) + `PhaseLoop` gate evaluation (`phase-loop.ts:378-454`)
