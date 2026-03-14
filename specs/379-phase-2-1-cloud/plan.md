# Implementation Plan: @generacy-ai/cluster-relay

**Feature**: WebSocket client package connecting local clusters to generacy-cloud for bidirectional communication
**Branch**: `379-phase-2-1-cloud`
**Status**: Complete

## Summary

New package `packages/cluster-relay/` providing a WebSocket client (`ClusterRelay` class) that maintains a persistent connection to `wss://api.generacy.ai/relay`. The relay authenticates via `GENERACY_API_KEY`, sends cluster metadata on handshake, and multiplexes API request proxying (cloud-to-cluster) and event forwarding (cluster-to-cloud) over a single connection. It supports both library import and standalone CLI modes.

## Technical Context

- **Language**: TypeScript (strict mode, ES2022 target, Node16 modules)
- **Runtime**: Node.js >= 20.0.0
- **Build**: `tsc` (same as all monorepo packages)
- **Test**: Vitest (node environment)
- **Package Manager**: pnpm workspaces
- **WebSocket**: `ws` package (Node.js 22+ built-in WebSocket is still experimental for client use; `ws` is proven and matches the monorepo's production-grade approach)
- **HTTP Client**: Native `fetch()` for proxying API requests to local orchestrator
- **Key Pattern**: Follow `packages/orchestrator/src/services/smee-receiver.ts` for reconnection with exponential backoff

## Project Structure

```
packages/cluster-relay/
├── src/
│   ├── index.ts                    # Barrel exports (ClusterRelay, types, config)
│   ├── cli.ts                      # CLI entry point (standalone mode)
│   ├── relay.ts                    # ClusterRelay class — core connection logic
│   ├── config.ts                   # Configuration schema (Zod) and loader
│   ├── messages.ts                 # Message type definitions (discriminated union)
│   ├── proxy.ts                    # API request proxying (cloud → local orchestrator)
│   ├── metadata.ts                 # ClusterMetadata collection (query /health, /metrics)
│   └── events.ts                   # EventEmitter interface for library-mode event forwarding
├── tests/
│   ├── relay.test.ts               # Core relay connection/reconnection tests
│   ├── proxy.test.ts               # API proxying tests
│   ├── messages.test.ts            # Message serialization/parsing tests
│   ├── metadata.test.ts            # Metadata collection tests
│   └── config.test.ts              # Configuration validation tests
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Implementation Phases

### Phase 1: Package Scaffold & Types

**Files**: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/messages.ts`, `src/config.ts`

1. Create package boilerplate following `packages/orchestrator/` conventions
   - `"name": "@generacy-ai/cluster-relay"`, `"type": "module"`, `"version": "0.1.0"`
   - `"bin": { "cluster-relay": "./dist/cli.js" }` for CLI entry point
   - Dependencies: `ws`, `zod`
   - Dev dependencies: `@types/ws`, `vitest`, `tsx`, `typescript`

2. Define message types as discriminated union in `src/messages.ts`
   - `RelayMessage` union type (7 variants)
   - `ClusterMetadata` interface
   - Zod schemas for runtime validation of incoming messages

3. Define configuration schema in `src/config.ts`
   - `GENERACY_API_KEY` (required) — cloud authentication
   - `ORCHESTRATOR_API_KEY` (optional) — local orchestrator auth for standalone mode
   - `RELAY_URL` (default: `wss://api.generacy.ai/relay`)
   - `ORCHESTRATOR_URL` (default: `http://localhost:3000`)
   - `REQUEST_TIMEOUT_MS` (default: 30000)
   - Load from env vars, with constructor override support

### Phase 2: Core WebSocket Client

**Files**: `src/relay.ts`

4. Implement `ClusterRelay` class with connection lifecycle
   - Constructor accepts config options + optional logger
   - `connect()` — establish WebSocket, authenticate, send handshake
   - `disconnect()` — graceful close with WebSocket close frame
   - `send(message: RelayMessage)` — serialize and send
   - `onMessage(handler)` — register message handler
   - Internal state machine: `disconnected → connecting → authenticating → connected → disconnecting`

5. Implement reconnection with exponential backoff (follow smee-receiver.ts)
   - Backoff sequence: 5s → 10s → 20s → 40s → 80s → 160s → 300s (max)
   - Reset backoff on successful connection
   - `AbortController` for cancellable sleep during reconnection
   - Re-authenticate and re-send metadata on reconnect
   - While loop with `running` flag check

6. Implement ping/pong heartbeat
   - Send `{ type: 'heartbeat' }` on WebSocket ping or at regular interval
   - Detect stale connections via pong timeout
   - Trigger reconnection on heartbeat failure

### Phase 3: API Request Proxying

**Files**: `src/proxy.ts`

7. Implement request proxy handler
   - Receive `api_request` messages from cloud
   - Forward to local orchestrator via `fetch()` at configured `ORCHESTRATOR_URL`
   - Include `X-API-Key` header with `ORCHESTRATOR_API_KEY` if configured
   - Return `api_response` with matching `id`, status, headers, body
   - Timeout handling via `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`
   - Error responses for network failures, timeouts, invalid requests

### Phase 4: Metadata Collection & Event Interface

**Files**: `src/metadata.ts`, `src/events.ts`

8. Implement metadata collection for handshake
   - Query orchestrator `/health` endpoint (auth-exempt) for service status
   - Query orchestrator `/metrics` endpoint for workflow/queue counts
   - Parse git remotes from local `.git/config` or `git remote -v`
   - Fallback defaults when orchestrator is unreachable
   - Expose `collectMetadata()` function and accept manual override via constructor

9. Define event forwarding interface for library mode
   - `EventEmitter`-style interface: `relay.pushEvent(channel, event)`
   - In library mode, orchestrator calls this directly (no SSE connection needed)
   - Define but do not implement SSE subscription for standalone mode (deferred to 2.2)
   - `conversation` message type defined for forward compatibility (Phase 4 feature)

### Phase 5: CLI Entry Point

**Files**: `src/cli.ts`

10. Implement standalone CLI
    - Parse env vars and minimal CLI flags (`--relay-url`, `--orchestrator-url`)
    - Instantiate `ClusterRelay` with config
    - Handle SIGINT/SIGTERM for graceful shutdown
    - Log connection status, reconnection events
    - Exit codes: 0 (clean shutdown), 1 (fatal error)

### Phase 6: Tests

**Files**: `tests/*.test.ts`

11. Unit tests for message parsing and validation
12. Unit tests for configuration loading and defaults
13. Unit tests for relay connection state machine (mock WebSocket)
14. Unit tests for API proxy (mock fetch)
15. Unit tests for metadata collection (mock fetch responses)
16. Integration test for reconnection backoff timing

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| WebSocket library | `ws` package | Stable, widely used; Node.js built-in WebSocket still experimental for client |
| Message validation | Zod discriminated union | Consistent with monorepo pattern; runtime safety for incoming messages |
| HTTP proxying | Native `fetch()` | Available in Node 20+; no extra dependency needed |
| Event forwarding | In-process EventEmitter interface | Avoids consuming SSE connection slots; cleaner for library mode (per clarification Q1) |
| Local auth | Separate `ORCHESTRATOR_API_KEY` | Distinct from cloud API key; uses existing `X-API-Key` header (per clarification Q2) |
| Metadata source | Query `/health` + `/metrics` | Auth-exempt endpoints provide live data (per clarification Q3) |
| Conversation type | Define type only, no implementation | Phase 4 feature; forward-compatible type definition (per clarification Q4) |
| Default port | `localhost:3000` | Matches actual orchestrator default (per clarification Q5) |

## Dependencies

- **Upstream**: None (can start immediately)
- **Downstream**: Issue 2.2 (orchestrator integration) will import `ClusterRelay` as a library
- **Parallel**: Issue 2.3 (cloud relay service) develops the server side independently

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Cloud relay server not ready for E2E testing | Test against mock WebSocket server; contract-test message formats |
| WebSocket connection unreliable on poor networks | Exponential backoff with 300s cap; heartbeat detection |
| Message format changes between relay and cloud | Zod validation at boundary; version field can be added later |

---

*Generated by speckit*
