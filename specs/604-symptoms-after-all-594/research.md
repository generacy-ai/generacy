# Research: VS Code Tunnel Device Code Race Condition

## Pattern: Late-Subscriber Catch-Up

The core problem is the "late subscriber" pattern — a consumer subscribes to an event stream after the relevant event has already been emitted. Three common solutions:

### Option A: Event replay / buffering (rejected)
Cloud-side SSE infrastructure buffers last N events per cluster and replays on new subscription. This is the most general solution but requires cloud infrastructure changes. Overkill for a single event type.

### Option B: Persist transient data to Firestore (rejected)
Store `deviceCode` in Firestore alongside `vscodeTunnelStatus`. Dialog reads from Firestore on mount. Violates the hybrid design principle from #541 Q1: transient data (device codes with ~15min TTL) should flow through events only, not be persisted. Creates stale cleanup problem.

### Option C: Re-emit current state on idempotent call (chosen)
When `start()` is called and the process is already running, re-emit the current state event. This is the "newly-subscribed listener catches up" pattern referenced in #541 Q3. Minimal change, architecturally aligned, no infrastructure dependencies.

**Decision**: Option C. Two instance fields + conditional re-emit in the early-return path.

## Implementation Pattern Analysis

### Current `start()` flow
```
start() called → child exists? → YES → return {status, tunnelName}  (no event)
                                → NO  → spawn child, emit 'starting', return
```

### Proposed `start()` flow
```
start() called → child exists? → YES → re-emit current state → return {status, tunnelName}
                                → NO  → spawn child, emit 'starting', return
```

### Field lifecycle
```
deviceCode/verificationUri:
  null (constructor)
  → set (handleStdoutLine matches device code)
  → cleared (exit event OR error event OR transition to 'connected')
```

### Why clear on `connected`?
Once the tunnel connects, the device code is consumed and useless. Clearing prevents accidentally re-emitting stale device codes if the state machine has a bug. The `connected` re-emit path doesn't need device code fields.

## Testing Strategy

Existing test infrastructure uses:
- `vi.mock('node:child_process')` with `spawnMock` for process control
- `createMockChild()` returning an EventEmitter with stdout/stderr
- `pushLine()` helper for simulating stdout
- `relayEvents` array capturing all emitted events
- `vi.useFakeTimers()` for timeout testing

New tests extend the existing "start() idempotency" describe block. No new test infrastructure needed.

## References

- #584 — Introduced `VsCodeTunnelProcessManager` and device code parsing
- #594 — IPC relay channel (control-plane → orchestrator → cloud)
- #541 Q3 — Design decision: late-subscriber catch-up via re-emit
- RFC 8628 — OAuth 2.0 Device Authorization Grant (device code TTL context)
