# Tasks: @generacy-ai/cluster-relay

**Input**: Design documents from `/specs/379-phase-2-1-cloud/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Package Scaffold & Types

- [ ] T001 Create `packages/cluster-relay/package.json` — name `@generacy-ai/cluster-relay`, type module, version 0.1.0, bin entry `cluster-relay: ./dist/cli.js`, dependencies (`ws`, `zod`), devDependencies (`@types/ws`, `vitest`, `tsx`, `typescript`)
- [ ] T002 [P] Create `packages/cluster-relay/tsconfig.json` — follow `packages/orchestrator/tsconfig.json` conventions (strict, ES2022 target, Node16 modules)
- [ ] T003 [P] Create `packages/cluster-relay/vitest.config.ts` — node environment, match `tests/*.test.ts`
- [ ] T004 Implement `packages/cluster-relay/src/messages.ts` — `RelayMessage` discriminated union (7 variants: `api_request`, `api_response`, `event`, `conversation`, `heartbeat`, `handshake`, `error`), `ClusterMetadata` interface, `GitRemote` interface, Zod schemas for runtime validation of incoming messages
- [ ] T005 [P] Implement `packages/cluster-relay/src/config.ts` — `RelayConfig` interface, `RelayConfigSchema` Zod schema with defaults (`relayUrl: wss://api.generacy.ai/relay`, `orchestratorUrl: http://localhost:3000`, `requestTimeoutMs: 30000`, `heartbeatIntervalMs: 30000`, `baseReconnectDelayMs: 5000`, `maxReconnectDelayMs: 300000`), `loadConfig()` function loading from env vars with constructor override
- [ ] T006 [P] Create `packages/cluster-relay/src/index.ts` — barrel exports for `ClusterRelay`, types, config

## Phase 2: Core Implementation

- [ ] T007 Implement `packages/cluster-relay/src/relay.ts` — `ClusterRelay` class with state machine (`disconnected → connecting → authenticating → connected → disconnecting`), constructor accepting config + optional logger, `connect()`, `disconnect()`, `send()`, `onMessage()` methods
- [ ] T008 Implement reconnection with exponential backoff in `relay.ts` — follow `smee-receiver.ts` pattern: `while(running)` loop, cancellable `sleep()` via AbortController, backoff sequence 5s→10s→20s→40s→80s→160s→300s, reset on successful connection, re-authenticate and re-send metadata on reconnect
- [ ] T009 Implement ping/pong heartbeat in `relay.ts` — send `{ type: 'heartbeat' }` at `heartbeatIntervalMs` interval, detect stale connections via pong timeout, trigger reconnection on heartbeat failure

## Phase 3: API Proxying & Event Interface

- [ ] T010 Implement `packages/cluster-relay/src/proxy.ts` — `handleApiRequest()` function: receive `ApiRequestMessage`, forward to orchestrator via `fetch()` at configured `orchestratorUrl`, include `X-API-Key` header if `orchestratorApiKey` configured, return `ApiResponseMessage` with matching `id`, timeout via `AbortSignal.timeout(requestTimeoutMs)`, error responses (502 network, 504 timeout)
- [ ] T011 [P] Implement `packages/cluster-relay/src/metadata.ts` — `collectMetadata()` function: query `/health` and `/metrics` endpoints, parse git remotes from `git remote -v`, fallback defaults when endpoints unreachable, accept manual override via `setMetadata()`
- [ ] T012 [P] Implement `packages/cluster-relay/src/events.ts` — EventEmitter-style interface: `pushEvent(channel, event)` sends `EventMessage` over WebSocket, define SSE subscription interface for standalone mode (not implemented, deferred to 2.2)

## Phase 4: CLI Entry Point

- [ ] T013 Implement `packages/cluster-relay/src/cli.ts` — parse env vars + CLI flags (`--relay-url`, `--orchestrator-url`), instantiate `ClusterRelay`, handle SIGINT/SIGTERM for graceful shutdown, log connection status and reconnection events, exit codes 0 (clean) / 1 (fatal)

## Phase 5: Tests

- [ ] T014 Write `packages/cluster-relay/tests/messages.test.ts` — unit tests for message type parsing and Zod validation (valid messages, invalid messages, unknown types)
- [ ] T015 [P] Write `packages/cluster-relay/tests/config.test.ts` — unit tests for config loading, defaults, env var override, validation errors
- [ ] T016 [P] Write `packages/cluster-relay/tests/relay.test.ts` — unit tests for connection state machine, connect/disconnect lifecycle, reconnection with backoff, heartbeat (mock WebSocket via `ws` Server)
- [ ] T017 [P] Write `packages/cluster-relay/tests/proxy.test.ts` — unit tests for API request proxying: success, network error (502), timeout (504), auth header forwarding (mock `fetch`)
- [ ] T018 [P] Write `packages/cluster-relay/tests/metadata.test.ts` — unit tests for metadata collection: health/metrics query, git remote parsing, fallback defaults (mock `fetch`)

## Phase 6: Integration & Polish

- [ ] T019 Run `pnpm install` from monorepo root to wire workspace, verify `pnpm build` compiles successfully
- [ ] T020 Update `packages/cluster-relay/src/index.ts` barrel exports to match final public API surface
- [ ] T021 Verify CLI entry point works: `pnpm --filter @generacy-ai/cluster-relay dev` starts without error (with mock/missing cloud endpoint, confirm graceful reconnection backoff)

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 must complete before T002, T003 (need package.json for workspace)
- T004 must complete before T007 (relay imports message types)
- T005 must complete before T007 (relay imports config)
- T007-T009 are sequential (T008 extends T007, T009 extends T008)
- T007 must complete before T010, T011, T012 (proxy/metadata/events integrate with relay)
- T010-T012 must complete before T013 (CLI wires everything together)
- Phase 5 tests can begin as soon as their target module is complete
- T019-T021 require all prior phases complete

**Parallel opportunities**:
- T002, T003 can run in parallel after T001
- T004, T005, T006 can run in parallel after T001
- T010, T011, T012 can run in parallel after T007-T009
- T014-T018 can all run in parallel once their target modules exist
- T015 can start after T005; T014 can start after T004; T016 after T009; T017 after T010; T018 after T011

---

*Generated by speckit*
