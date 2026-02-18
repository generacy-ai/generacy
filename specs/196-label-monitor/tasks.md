# Tasks: Label Monitor with Webhook/Poll Hybrid Detection

**Input**: Design documents from `/specs/196-label-monitor/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md, research.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)

## Phase 1: Configuration & Types

- [ ] T001 [US1] Extend orchestrator config schema with `MonitorConfigSchema` in `src/config/schema.ts` — add `monitor` section with `pollIntervalMs`, `webhookSecret`, `maxConcurrentPolls`, `adaptivePolling` fields using Zod
- [ ] T002 [P] [US1] Define monitor types in `src/types/monitor.ts` — `QueueItem`, `LabelEvent`, `GitHubWebhookPayload`, `MonitorState`, `QueueAdapter` interface, `PhaseTracker` interface
- [ ] T003 [P] [US1] Export new types from `src/types/index.ts`

## Phase 2: Phase Tracker (Deduplication)

- [ ] T004 [US4] Implement `PhaseTrackerService` in `src/services/phase-tracker-service.ts` — Redis-backed deduplication with `isDuplicate()` and `markProcessed()` methods, key pattern `phase-tracker:{owner}:{repo}:{issue}:{phase}`, 24h TTL, graceful degradation when Redis unavailable
- [ ] T005 [P] [US4] Write unit tests for `PhaseTrackerService` in `tests/unit/services/phase-tracker-service.test.ts` — test dedup key creation, TTL behavior, Redis failure fallback, key format validation

## Phase 3: Core Monitor Service

- [ ] T006 [US1] Implement `LabelMonitorService` core in `src/services/label-monitor-service.ts` — constructor with dependency injection (logger, GitHubClient factory, PhaseTracker, QueueAdapter, config), `parseLabelEvent()` to extract workflow name from `process:*` labels
- [ ] T007 [US1] Implement `processLabelEvent()` in `LabelMonitorService` — shared processing logic: check dedup → enqueue → remove trigger label → add `agent:in-progress` label, with structured logging
- [ ] T008 [US3] Implement `waiting-for:*/completed:*` resume detection in `processLabelEvent()` — detect `completed:*` label, check for matching `waiting-for:*` on same issue, enqueue "continue" command, remove `waiting-for:*` label
- [ ] T009 [US2] Implement polling loop in `LabelMonitorService` — `startPolling()`, `stopPolling()`, `poll()` methods using AbortController pattern, iterate watched repos, find issues with `process:*` labels via GitHubClient
- [ ] T010 [US2] Implement adaptive polling in `LabelMonitorService` — track webhook health via `lastWebhookEvent` timestamp, reduce interval by 3x when webhooks unhealthy (min 10s), restore normal interval on reconnect, log mode transitions
- [ ] T011 [US2] Implement concurrency limiting for polling — cap concurrent GitHub API calls to `maxConcurrentPolls` using semaphore pattern when polling multiple repos simultaneously

## Phase 4: Webhook Route

- [ ] T012 [US2] Implement webhook route in `src/routes/webhooks.ts` — `POST /webhooks/github` Fastify route with raw body capture for signature verification
- [ ] T013 [US2] Implement HMAC-SHA256 webhook signature verification — verify `X-Hub-Signature-256` header using `crypto.timingSafeEqual`, skip when `webhookSecret` not configured
- [ ] T014 [US2] Wire webhook handler to `LabelMonitorService.processLabelEvent()` — parse payload, validate action is `labeled`, filter for watched repos, call shared processing logic, update webhook health timestamp

## Phase 5: Server Integration

- [ ] T015 [US1] Integrate `LabelMonitorService` into `src/server.ts` — instantiate service with dependencies, start polling on `server.ready`, stop on graceful shutdown
- [ ] T016 [P] [US1] Register webhook route in `src/routes/index.ts` — add `setupWebhookRoutes()` to `registerRoutes()`, pass monitor service reference
- [ ] T017 [P] [US1] Export new services and types from `src/services/index.ts` and `src/index.ts`
- [ ] T018 [P] [US1] Add `ioredis` dependency to `package.json` if not already present

## Phase 6: Tests

- [ ] T019 [US1] Write unit tests for `LabelMonitorService` in `tests/unit/services/label-monitor-service.test.ts` — test `parseLabelEvent()` for `process:*` labels, test `processLabelEvent()` with mocked GitHubClient/PhaseTracker/QueueAdapter, verify label removal and `agent:in-progress` addition
- [ ] T020 [P] [US3] Write unit tests for resume detection — test `completed:*` + `waiting-for:*` pair detection, verify "continue" command enqueue, verify `waiting-for:*` removal
- [ ] T021 [P] [US2] Write unit tests for polling loop — test polling iterates repos, test adaptive frequency changes based on webhook health, test AbortController stops polling cleanly
- [ ] T022 [P] [US4] Write unit tests for dedup integration — test that duplicate events are skipped, test that non-duplicates proceed normally
- [ ] T023 [US2] Write unit tests for webhook route — test signature verification, test payload parsing, test rejection of non-`labeled` events, test filtering for watched repos only

## Dependencies & Execution Order

**Sequential phase dependencies:**
- Phase 1 (Config & Types) → Phase 2 (Phase Tracker) → Phase 3 (Core Monitor) → Phase 4 (Webhook Route) → Phase 5 (Server Integration) → Phase 6 (Tests)

**Parallel opportunities within phases:**
- **Phase 1**: T002 and T003 can run in parallel with T001 (different files)
- **Phase 2**: T005 (tests) can run in parallel with T004 (implementation)
- **Phase 3**: T006–T011 are mostly sequential (each builds on prior methods)
- **Phase 5**: T016, T017, T018 can run in parallel with T015 (different files)
- **Phase 6**: T020, T021, T022 can run in parallel (different test files/concerns); T023 depends on T012-T014

**Critical path:** T001 → T004 → T006 → T007 → T009 → T012 → T015 → T019

---

*Generated by speckit*
