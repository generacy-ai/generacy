# Tasks: Orchestrator Relay Integration

**Input**: Design documents from `/specs/380-phase-2-2-cloud/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/relay-client-interface.ts
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types & Configuration

- [X] T001 Create relay type definitions in `packages/orchestrator/src/types/relay.ts`
  - Define `ClusterRelayClient` interface (connect, disconnect, send, on, off, isConnected)
  - Define `ClusterRelayClientOptions` interface (apiKey, cloudUrl, baseReconnectDelayMs)
  - Define `RelayMessage` discriminated union (`api_request`, `api_response`, `event`, `metadata`)
  - Define `RelayApiRequest`, `RelayApiResponse`, `RelayEvent`, `RelayMetadata` interfaces
  - Define `ClusterMetadataPayload` and `GitRemoteInfo` interfaces
  - Define `RelayConfig` interface (apiKey, cloudUrl, metadataIntervalMs, clusterYamlPath)
  - Define `RelayBridgeOptions` interface (client, server, sseManager, logger, config)
  - Import SSE types (`SSEChannel`, `SSEEvent`) from existing `types/sse.ts`
  - Export all types from `types/index.ts`
  - Reference: `specs/380-phase-2-2-cloud/contracts/relay-client-interface.ts` and `data-model.md`

- [X] T002 [P] Add `RelayConfigSchema` to `packages/orchestrator/src/config/schema.ts`
  - Add Zod schema: `apiKey` (optional string), `cloudUrl` (url, default `wss://api.generacy.ai/relay`), `metadataIntervalMs` (int min 10000, default 60000), `clusterYamlPath` (string, default `.generacy/cluster.yaml`)
  - Add `relay: RelayConfigSchema.default({})` to `OrchestratorConfigSchema`
  - Export `RelayConfig` type

- [X] T003 [P] Map `GENERACY_API_KEY` env var in `packages/orchestrator/src/config/loader.ts`
  - Read `GENERACY_API_KEY` from environment
  - Optionally read `GENERACY_CLOUD_URL` for the relay WebSocket URL
  - Map to `config.relay = { apiKey, cloudUrl }` in `loadFromEnv()`

## Phase 2: Core Implementation

- [X] T004 Create `RelayBridge` service in `packages/orchestrator/src/services/relay-bridge.ts`
  - Constructor takes `RelayBridgeOptions` (client, server, sseManager, logger, config)
  - **`start()`**: Connect relay client, register message handler, set up event forwarding, start metadata timer
  - **`stop()`**: Disconnect relay client, remove event forwarding, clear metadata timer
  - **API routing**: On `api_request` message → `server.inject({ method, url, headers, payload })` → send `api_response` with correlated `id`
  - **Event forwarding**: Decorate `sseManager.broadcast()` to also forward events via relay client as `event` messages; restore original on disconnect
  - **Metadata collection**: Gather version (from package.json), uptime (`process.uptime()`), active workflow count, git remotes (`git remote -v`), cluster.yaml fields (workerCount, channel) — each source wrapped in try/catch
  - **Metadata timer**: Send metadata on connect + every `config.metadataIntervalMs`
  - **Error isolation**: All relay operations wrapped in try/catch; log errors, never throw
  - Follow `SmeeWebhookReceiver` lifecycle pattern (start/stop with running flag)
  - Reference: `packages/orchestrator/src/services/smee-receiver.ts` for lifecycle pattern

- [X] T005 Write unit tests in `packages/orchestrator/src/services/__tests__/relay-bridge.test.ts`
  - Mock `ClusterRelayClient` implementation
  - Test API request routing: incoming `api_request` → `server.inject()` → `api_response` with correct `id`
  - Test event forwarding: `sseManager.broadcast()` sends relay `event` message
  - Test metadata collection: verify payload fields, handle missing cluster.yaml gracefully
  - Test metadata timer: fires on connect and periodically
  - Test error handling: relay send failure doesn't crash, connection failure logs warning
  - Test start/stop lifecycle: connect/disconnect called, decorator applied/removed
  - Test broadcast decorator restoration on stop

## Phase 3: Integration

- [X] T006 Wire `RelayBridge` into `packages/orchestrator/src/server.ts`
  - In full mode block (after existing service initialization): check `config.relay.apiKey`
  - If set: import and instantiate `ClusterRelayClient` from `@generacy-ai/cluster-relay` (with try/catch for missing package)
  - Create `RelayBridge` with client, server, SSE subscription manager, logger, config
  - Call `relayBridge.start()` in `onReady` hook (non-blocking, fire-and-forget with error logging)
  - Add `relayBridge.stop()` to shutdown cleanup array (before closing SSE connections)
  - If `@generacy-ai/cluster-relay` is not installed or API key is missing, skip silently (local-only mode)
  - Log relay connection status (connected/disconnected/reconnecting)

- [X] T007 [P] Add relay re-exports to `packages/orchestrator/src/index.ts`
  - Export relay types: `ClusterRelayClient`, `ClusterRelayClientOptions`, `RelayMessage`, `RelayApiRequest`, `RelayApiResponse`, `RelayEvent`, `RelayMetadata`, `ClusterMetadataPayload`, `GitRemoteInfo`, `RelayConfig`, `RelayBridgeOptions`
  - Export `RelayBridge` class

- [X] T008 Write integration/degradation tests in `packages/orchestrator/src/__tests__/relay-integration.test.ts`
  - Test orchestrator starts normally when `GENERACY_API_KEY` is not set (no relay)
  - Test orchestrator starts normally when `@generacy-ai/cluster-relay` package is missing
  - Test orchestrator starts normally when relay connection fails (continues local-only)
  - Test end-to-end API routing: mock relay client → api_request → Fastify inject → api_response
  - Test graceful shutdown disconnects relay before closing server

## Dependencies & Execution Order

```
T001 ─────────┐
              ├──→ T004 ──→ T005 ──→ T006 ──→ T008
T002 ──┐      │
       ├──────┘
T003 ──┘

T007 can run in parallel with T006-T008 (independent file)
```

- **T001** must complete first (types used by everything)
- **T002, T003** can run in parallel with each other; both must complete before T004
- **T004** depends on T001, T002, T003 (uses types and config)
- **T005** depends on T004 (tests the service)
- **T006** depends on T004 (wires service into server)
- **T007** can run any time after T004 (just re-exports)
- **T008** depends on T006 (integration tests need full wiring)
