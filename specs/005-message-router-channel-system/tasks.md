# Tasks: Message Router and Channel System

**Input**: Design documents from `/specs/005-message-router-channel-system/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which acceptance criterion this task addresses

## Phase 1: Core Types and Interfaces

- [X] T001 Create project structure (`src/router/`, `src/connections/`, `src/channels/`, `src/persistence/`, `src/types/`, `src/utils/`)
- [X] T002 [P] Define MessageEnvelope, MessageType, MessageEndpoint, MessageMeta types (`src/types/messages.ts`)
- [X] T003 [P] Define AgencyConnection, HumancyConnection, MessageHandler interfaces (`src/types/connections.ts`)
- [X] T004 [P] Define Channel, ChannelHandler, ChannelContext types (`src/types/channels.ts`)
- [X] T005 Create public exports for types module (`src/types/index.ts`)

## Phase 2: Utility Functions

- [X] T006 Implement exponential backoff retry utility with jitter (`src/utils/retry.ts`)
- [X] T007 [P] Implement TTL calculation helpers (`src/utils/ttl.ts`)
- [X] T008 [P] Write unit tests for retry utility (`tests/utils/retry.test.ts`)
- [X] T009 [P] Write unit tests for TTL utility (`tests/utils/ttl.test.ts`)

## Phase 3: Connection Management

- [X] T010 [AC6] Implement ConnectionRegistry class with register/unregister/markOffline/markOnline (`src/connections/connection-registry.ts`)
- [X] T011 [P] [AC6] Implement AgencyConnection wrapper (`src/connections/agency-connection.ts`)
- [X] T012 [P] [AC6] Implement HumancyConnection wrapper (`src/connections/humancy-connection.ts`)
- [X] T013 Create public exports for connections module (`src/connections/index.ts`)
- [X] T014 Write unit tests for ConnectionRegistry (`tests/connections/connection-registry.test.ts`)

## Phase 4: Basic Routing

- [X] T015 [AC1] Implement routing rules logic for 5 message types (`src/router/routing-rules.ts`)
- [X] T016 [AC1] [AC5] Implement MessageRouter core class with route() and broadcast methods (`src/router/message-router.ts`)
- [X] T017 Create public exports for router module (`src/router/index.ts`)
- [X] T018 Write unit tests for routing rules (`tests/router/routing-rules.test.ts`)
- [X] T019 [P] Write unit tests for MessageRouter (`tests/router/message-router.test.ts`)

## Phase 5: Correlation Tracking

- [X] T020 [AC2] Implement CorrelationManager with waitForCorrelation and correlate methods (`src/router/correlation-manager.ts`)
- [X] T021 [AC2] Integrate CorrelationManager into MessageRouter for routeAndWait (`src/router/message-router.ts`)
- [X] T022 Write unit tests for CorrelationManager (`tests/router/correlation-manager.test.ts`)

## Phase 6: Redis Persistence

- [X] T023 [AC3] Implement RedisStore adapter for connection/message storage (`src/persistence/redis-store.ts`)
- [X] T024 [AC3] Implement MessageQueue for offline recipient queuing (`src/persistence/message-queue.ts`)
- [X] T025 [AC3] Implement deliver-on-reconnect logic in ConnectionRegistry (`src/connections/connection-registry.ts`)
- [X] T026 Create public exports for persistence module (`src/persistence/index.ts`)
- [X] T027 Write integration tests for MessageQueue with Redis (`tests/persistence/message-queue.test.ts`)

## Phase 7: Dead Letter Queue

- [X] T028 [AC4] Implement DeadLetterQueue with exponential backoff retry (`src/persistence/dead-letter-queue.ts`)
- [X] T029 [AC4] Implement manual inspection API for DLQ (`src/persistence/dead-letter-queue.ts`)
- [X] T030 [AC4] Integrate DLQ into MessageRouter for failed message handling (`src/router/message-router.ts`)
- [X] T031 Write unit tests for DeadLetterQueue (`tests/persistence/dead-letter-queue.test.ts`)

## Phase 8: Channel System

- [X] T032 Implement ChannelRegistry for dynamic channel registration (`src/channels/channel-registry.ts`)
- [X] T033 Implement ChannelHandler for channel message routing (`src/channels/channel-handler.ts`)
- [X] T034 Integrate channel routing into MessageRouter (`src/router/message-router.ts`)
- [X] T035 Create public exports for channels module (`src/channels/index.ts`)
- [X] T036 Write unit tests for ChannelRegistry (`tests/channels/channel-registry.test.ts`)

## Phase 9: Integration and Final Exports

- [X] T037 Create main package entry point with all public exports (`src/index.ts`)
- [X] T038 Write end-to-end integration tests for complete routing scenarios (`tests/integration/routing.test.ts`)
- [X] T039 Add RouterConfig type and configuration validation (`src/types/config.ts`)

## Dependencies & Execution Order

**Sequential dependencies:**
- Phase 1 (Types) must complete before all other phases
- Phase 2 (Utilities) can run parallel to Phase 1 after T001
- Phase 3 (Connections) requires Phase 1 types
- Phase 4 (Routing) requires Phase 3 connections
- Phase 5 (Correlation) requires Phase 4 router
- Phase 6 (Persistence) requires Phase 3 connections and Phase 4 router
- Phase 7 (DLQ) requires Phase 6 persistence
- Phase 8 (Channels) requires Phase 4 router
- Phase 9 (Integration) requires all previous phases

**Parallel opportunities:**
- T002, T003, T004 can run in parallel (independent type files)
- T006, T007 can run in parallel (independent utilities)
- T008, T009 can run in parallel (independent test files)
- T010, T011, T012 can run in parallel after types complete
- T018, T019 can run in parallel (independent test files)

**Acceptance Criteria Mapping:**
- AC1 (Messages route between Agency and Humancy): T015, T016
- AC2 (Correlation tracking): T020, T021, T022
- AC3 (Offline message queuing): T023, T024, T025, T027
- AC4 (Dead letter queue): T028, T029, T030, T031
- AC5 (Broadcast to multiple recipients): T016
- AC6 (Connection lifecycle managed): T010, T011, T012, T014
