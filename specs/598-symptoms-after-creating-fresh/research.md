# Research: Wizard-mode relay bridge initialization failure

**Branch**: `598-symptoms-after-creating-fresh` | **Date**: 2026-05-12

## Problem Analysis

### Root Cause Chain

1. **PR #567** introduced wizard-mode background activation: `server.listen()` runs before activation completes
2. **PR #594** added `setupInternalRelayEventsRoute(server, relayClient)` inside `initializeRelayBridge()` — registers a Fastify POST route
3. In wizard mode, `initializeRelayBridge()` runs **after** `server.listen()` (inside `activateInBackground()`)
4. Fastify freezes its routing tree on `listen()` — calling `server.post()` after this throws an error
5. The `try/catch` in `initializeRelayBridge()` (line 697) catches the error, logs "Relay bridge not available", and returns `null`
6. No relay bridge → no cloud connection → wizard shows "Cluster is not reachable"

### Fastify Route Registration Constraint

Fastify's design encapsulates route registration in the "setup phase" (before `listen()`/`ready()`). After the server is ready, the routing tree is compiled and frozen for performance. This is documented behavior and will not change.

Relevant Fastify internals:
- `server.post()` calls `server.route()` which throws after ready state
- Error: `Cannot add route when fastify instance is already started`

## Alternatives Considered

### Option A: Deferred binding via getter (SELECTED)

Register the route before `listen()` with a `() => ClusterRelayClient | null` getter. The handler resolves the client lazily on each request. Returns 503 when client is null.

**Pros**: Minimal change (~20 LOC), clean separation of route registration (setup phase) from client wiring (runtime phase), follows Fastify's design model.

**Cons**: Slight indirection in the handler (getter call per request).

### Option B: Fastify plugin with `decorate`

Use `server.decorate('relayClient', null)` before listen, then `server.relayClient = relayClient` after activation. Route handler reads from `request.server.relayClient`.

**Pros**: Fastify-idiomatic decoration pattern.

**Cons**: Requires type augmentation for `FastifyInstance`, more invasive change, decoration mutability is less explicit than a getter.

### Option C: Register route inside `onReady` hook

Use `server.addHook('onReady', ...)` to register the route just before the server starts accepting connections.

**Pros**: None — this doesn't solve the problem. Routes still can't be added inside `onReady` (the server is already compiling routes at that point).

**Cons**: Doesn't work — same Fastify constraint applies.

### Option D: Re-create server after activation

Destroy and re-create the Fastify instance after activation completes, registering all routes including the relay events route.

**Pros**: Clean slate.

**Cons**: Massive disruption — would drop all in-flight connections, lose the health endpoint, and break the `POST /internal/status` route that the control-plane uses during activation. Completely disproportionate to the problem.

### Option E: Use a separate HTTP server for internal IPC

Spawn a second `node:http` server on a different port/socket for the internal relay events route, bypassing Fastify entirely.

**Pros**: Decoupled from Fastify lifecycle.

**Cons**: Adds operational complexity (second port/socket), duplicates auth middleware, diverges from existing patterns.

## Decision

**Option A** is the clear winner. It requires the smallest change, respects Fastify's lifecycle model, and follows the existing pattern of deferred initialization already used by `activateInBackground()`.

## Key Implementation Patterns

### Deferred binding pattern

```typescript
// Setup phase (before listen)
let relayClientRef: ClusterRelayClient | null = null;
setupInternalRelayEventsRoute(server, () => relayClientRef);

// Runtime phase (after activation)
relayClientRef = newRelayClient;
```

This pattern is already used elsewhere in the orchestrator:
- `relayBridge` variable in `createServer()` is assigned via the `onInitialized` callback (line 314-317)
- `conversationManager` follows the same deferred assignment pattern

### 503 graceful degradation

Returning 503 during the pre-activation window is correct because:
- The control-plane process also cannot push relay events before the relay is connected
- HTTP 503 signals "temporarily unavailable" which is semantically accurate
- The control-plane's `setRelayPushEvent()` callback already has `.catch(log)` error handling

## References

- PR #567: Background activation for wizard mode
- PR #594: `setupInternalRelayEventsRoute` addition
- Fastify docs: [Route registration lifecycle](https://www.fastify.io/docs/latest/Reference/Routes/)
