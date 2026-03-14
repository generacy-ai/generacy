# Tasks: Interactive Conversation Proxy

**Input**: Design documents from `/specs/381-phase-4-1-cloud/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/conversation-api.yaml
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types & Configuration

- [ ] T001 [US1] Define conversation types and Zod schemas in `packages/orchestrator/src/conversation/types.ts` — `ConversationHandle`, `ConversationInfo`, `ConversationStartOptions`, `ConversationStartSchema`, `ConversationMessageSchema`, `ConversationRelayInputSchema`, `ConversationRelayOutputSchema` per data-model.md
- [ ] T002 [P] [US1] Refine `ConversationMessage` in `packages/cluster-relay/src/messages.ts` — add directional subtypes (`ConversationInputMessage`, `ConversationOutputMessage`) with typed `data` field, update `RelayMessage` union
- [ ] T003 [P] [US1] Add `ConversationConfig` to `packages/orchestrator/src/config/schema.ts` — `maxConcurrent`, `shutdownGracePeriodMs`, `workspaces` map, `defaultModel`; add `conversations` field to `OrchestratorConfigSchema`
- [ ] T004 [P] [US1] Add conversation relay types to `packages/orchestrator/src/types/relay.ts` — conversation message handling types, event type mapping (CLI output → conversation event)

## Phase 2: ConversationSpawner

- [ ] T005 [US1] Implement `ConversationSpawner` in `packages/orchestrator/src/conversation/conversation-spawner.ts` — spawn Claude CLI in interactive mode (or `-p --resume` fallback), configure `--output-format stream-json`, `--dangerously-skip-permissions`, `--model`, set `cwd`; expose `spawn()` returning process handle with stdin/stdout access
- [ ] T006 [US1] Implement stream-json output parser in `packages/orchestrator/src/conversation/output-parser.ts` — parse newline-delimited JSON from stdout, map CLI event types (`init`, `text`, `tool_use`, `tool_result`, `complete`, `error`) to `ConversationOutputMessage` events, emit parsed events via callback/EventEmitter
- [ ] T007 [P] [US1] Write unit tests for `ConversationSpawner` in `packages/orchestrator/src/conversation/__tests__/conversation-spawner.test.ts` — mock `ProcessFactory`, verify CLI args, verify stdin write, verify process cleanup (SIGTERM → SIGKILL)
- [ ] T008 [P] [US1] Write unit tests for output parser in `packages/orchestrator/src/conversation/__tests__/output-parser.test.ts` — test each CLI event type mapping, malformed JSON handling, partial line buffering

## Phase 3: ConversationManager

- [ ] T009 [US1] Implement `ConversationManager` in `packages/orchestrator/src/conversation/conversation-manager.ts` — `start()`: validate workspace ID, resolve to path, check concurrency limit, spawn via `ConversationSpawner`, track in `Map<string, ConversationHandle>`, attach output parser, forward events to callback; `sendMessage()`: lookup conversation, validate state is `active`, write to stdin; `end()`: transition to `ending`, close stdin, graceful kill, emit `complete`; `list()`: return `ConversationInfo[]` from active map; `stop()`: kill all active conversations on shutdown
- [ ] T010 [US1] Handle unexpected process exit in `ConversationManager` — attach exit handler per conversation, on unexpected exit: remove from map, emit `error` event with exit code, clean up resources
- [ ] T011 [US1] Write unit tests for `ConversationManager` in `packages/orchestrator/src/conversation/__tests__/conversation-manager.test.ts` — test start/sendMessage/end/list lifecycle, concurrency limit (429 at max), duplicate conversation ID (409), invalid workspace ID (400), unexpected exit notification, graceful shutdown (`stop()`)

## Phase 4: REST API Routes

- [ ] T012 [US1] Implement Fastify conversation routes in `packages/orchestrator/src/routes/conversations.ts` — `POST /conversations` (start, returns 201 with `ConversationInfo`), `POST /conversations/:id/message` (send, returns 202), `DELETE /conversations/:id` (end, returns 200), `GET /conversations` (list, returns 200); use Zod schemas for request validation; return RFC 7807 `ProblemDetail` on errors
- [ ] T013 [US1] Write unit tests for conversation routes in `packages/orchestrator/src/routes/__tests__/conversations.test.ts` — test each endpoint's success and error paths, request validation, proper HTTP status codes

## Phase 5: Relay Bridge Integration

- [ ] T014 [US1] Add conversation message handling to `packages/orchestrator/src/services/relay-bridge.ts` — handle incoming `conversation` relay messages: parse `ConversationRelayInputSchema`, route `action: 'message'` to `ConversationManager.sendMessage()`; forward `ConversationManager` output events as `ConversationOutputMessage` through relay client
- [ ] T015 [US1] Register conversation routes and services in `packages/orchestrator/src/server.ts` — instantiate `ConversationManager` with config, register conversation routes with manager dependency, wire `ConversationManager` output callback to `RelayBridge` conversation message sending, add `ConversationManager.stop()` to graceful shutdown sequence
- [ ] T016 [US1] Write unit tests for relay bridge conversation handling in `packages/orchestrator/src/services/__tests__/relay-bridge-conversation.test.ts` — test incoming message routing to manager, output event forwarding to relay, unknown conversation ID handling

## Phase 6: Integration Testing

- [ ] T017 [US1] Write integration test: full conversation lifecycle in `packages/orchestrator/src/conversation/__tests__/conversation-integration.test.ts` — start → send message → receive output events → end → verify cleanup
- [ ] T018 [P] [US1] Write integration test: concurrency and error paths in `packages/orchestrator/src/conversation/__tests__/conversation-integration.test.ts` — concurrent conversation limit enforcement, invalid workspace rejection, unexpected process exit notification, duplicate conversation ID rejection

## Dependencies & Execution Order

```
Phase 1: T001 first (types used everywhere), then T002/T003/T004 in parallel
Phase 2: T005 → T006 (parser depends on spawner output), then T007/T008 in parallel
Phase 3: T009 → T010 (exit handling extends manager), then T011
Phase 4: T012 → T013 (routes before route tests)
Phase 5: T014/T015 in parallel → T016
Phase 6: T017/T018 in parallel (independent test scenarios)
```

**Cross-phase dependencies**: Each phase depends on the previous phase's completion (types before spawner, spawner before manager, manager before routes, routes before relay integration, all before integration tests).

**Parallel opportunities**: 6 parallel pairs identified (T002/T003/T004, T007/T008, T014/T015, T017/T018).
