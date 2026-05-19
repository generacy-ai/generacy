# Research: Background Activation in Wizard Mode

**Branch**: `567-problem-wizard-mode-generacy` | **Date**: 2026-05-11

## Problem Analysis

### Root Cause

`packages/orchestrator/src/server.ts:309` calls `await activate(...)` inside `createServer()`. The `activate()` function (in `packages/orchestrator/src/activation/index.ts`) runs a device-code polling loop that blocks for up to 10 minutes (3 cycles x polling interval). Until it returns, `createServer()` never completes, `startServer()` never calls `server.listen()`, and port 3100 is never bound.

Docker's healthcheck (`curl -f http://localhost:3100/health`) fails → worker container never starts (due to `service_healthy` dependency) → launch CLI throws → user never reaches the browser activation page. Circular dependency.

### Why It Wasn't Caught Earlier

The cloud's `pending` discriminator had a schema parse error (fixed in generacy-cloud#534) that caused `pollForApproval` to throw immediately, skipping activation. The blocking await was always there but never actually blocked.

## Approach Evaluation

### Approach A: Background activation (SELECTED)

Fire `activate()` as a background promise, extract relay-bridge init into a callable function invoked on success.

**Pros**: Minimal diff (~50 lines changed). No new APIs. No changes to activation module. Preserves all existing behavior for non-wizard paths.
**Cons**: `relayBridge` and `conversationManager` are set asynchronously — shutdown closure must capture by reference (already does via `let` declarations).

### Approach B: Move activation outside `createServer()`

Extract activation to a separate lifecycle phase called from the entry point before `createServer()`.

**Pros**: Cleaner separation of concerns.
**Cons**: More invasive refactor. Entry point (`packages/orchestrator/src/index.ts` or similar) needs restructuring. Deferred per spec.

### Approach C: Two-phase server (listen first, configure later)

Split `createServer()` into `createServer()` + `configureServer()`. Listen immediately, then configure relay after activation.

**Pros**: Clean lifecycle model.
**Cons**: Over-engineered for this fix. Fastify routes registered after listen have edge cases with encapsulation.

### Approach D: Separate healthcheck listener

Bind a minimal HTTP server on a different port for healthcheck only.

**Pros**: Decouples health from main server entirely.
**Cons**: Over-engineered. Extra port. Extra process management.

## Implementation Pattern

The background activation pattern follows existing patterns in the codebase:

1. **`onReady` hook** (server.ts:527-573) already uses fire-and-forget `.catch()` for `labelMonitorService.startPolling()`, `relayBridge.start()`, etc.
2. **Worker relay client** (server.ts:531-533) already backgrounds connection with `.catch()`.
3. The pattern of `let variable = null` → conditionally assign → closure captures by reference is used throughout `createServer()` for `relayBridge`, `conversationManager`, `workerDispatcher`, etc.

## Key Observations

- `/health` endpoint is registered via `setupHealthRoutes()` (line 433) or `registerRoutes()` (line 455). It does NOT check activation state — it's a simple liveness check. The only problem is that `server.listen()` hasn't been called yet.
- The `onReady` hook (line 527) fires after `server.listen()`. For the synchronous relay bridge path (apiKey already exists), `relayBridge.start()` is called here. For the background path, we must call `relayBridge.start()` directly since the server is already listening by the time activation completes.
- ConversationManager wiring to relay (lines 419-421) must happen after relay bridge exists. In the background path, both are created sequentially in the async function.
- StatusReporter (lines 387-392) is wired to relayBridge. In the background path, this wiring happens inside the async function after relay bridge creation.

## References

- generacy-ai/generacy-cloud#534 — PR that exposed the bug
- generacy-ai/generacy#566 — earlier wizard-mode fix (label monitor)
- RFC 8628 — Device Authorization Grant (the device-code flow spec)
