# Tasks: Cluster-relay protocol additions and path-prefix dispatcher

**Input**: Design documents from `/specs/489-context-v1-5-introduces/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Protocol Schema Additions

- [ ] T001 [P] Add `ActorSchema` and `ActivationSchema` Zod schemas to `packages/cluster-relay/src/messages.ts` — define `ActorSchema` (`userId: string`, `sessionId?: string`) and `ActivationSchema` (`code: string`, `clusterApiKeyId?: string`)
- [ ] T002 [P] Extend `ApiRequestMessageSchema` with optional `actor` field and `HandshakeMessageSchema` with optional `activation` field in `packages/cluster-relay/src/messages.ts`
- [ ] T003 [P] Export `Actor` and `Activation` TypeScript types from `packages/cluster-relay/src/messages.ts`

## Phase 2: Config Schema Extensions

- [ ] T004 Define `RouteEntrySchema` in `packages/cluster-relay/src/config.ts` — `prefix: z.string().startsWith('/')`, `target: z.string()`
- [ ] T005 Add `routes`, `activationCode`, and `clusterApiKeyId` fields to `RelayConfigSchema` in `packages/cluster-relay/src/config.ts` — `routes` defaults to `[]`, activation fields are optional
- [ ] T006 Update `loadConfig()` in `packages/cluster-relay/src/config.ts` to accept `routes`, `activationCode`, and `clusterApiKeyId` via overrides (no env vars per clarification Q4)

## Phase 3: Path-Prefix Dispatcher

- [ ] T007 Create `packages/cluster-relay/src/dispatcher.ts` with `RouteEntry` type, `sortRoutes()` function (sort by prefix length descending)
- [ ] T008 Implement `resolveRoute(path, routes)` in `dispatcher.ts` — longest-prefix-match, strip matched prefix, return `{ route, strippedPath }` or null
- [ ] T009 [P] Implement `isUnixSocket(target)` and `parseUnixTarget(target)` utility functions in `dispatcher.ts`

## Phase 4: Proxy Rewrite

- [ ] T010 Import dispatcher functions into `packages/cluster-relay/src/proxy.ts` and refactor `handleApiRequest` to call `resolveRoute()` for matched routes, falling back to `orchestratorUrl`
- [ ] T011 Add Unix socket forwarding path in `proxy.ts` using Node.js `http.request()` with `socketPath` option for `unix://` targets
- [ ] T012 Wire `actor` header propagation in `proxy.ts` — set `x-generacy-actor-user-id` and `x-generacy-actor-session-id` headers on forwarded requests when `request.actor` is present

## Phase 5: Relay Integration

- [ ] T013 Pre-sort `config.routes` via `sortRoutes()` in `ClusterRelay` constructor or `connect()` in `packages/cluster-relay/src/relay.ts`
- [ ] T014 Include `activation` field in handshake message when `config.activationCode` is set in `packages/cluster-relay/src/relay.ts`

## Phase 6: Tests

- [ ] T015 [P] Add message schema tests in `packages/cluster-relay/tests/messages.test.ts` — ApiRequestMessage with/without actor, HandshakeMessage with/without activation, invalid shapes rejected
- [ ] T016 [P] Create `packages/cluster-relay/tests/dispatcher.test.ts` — longest-prefix-match, prefix stripping, no-match returns null, empty routes, Unix socket detection/parsing
- [ ] T017 [P] Extend `packages/cluster-relay/tests/proxy.test.ts` — control-plane prefix → Unix socket forwarding, fallback to orchestrator, actor headers present/absent, mixed route scenarios
- [ ] T018 [P] Extend `packages/cluster-relay/tests/config.test.ts` — routes default to `[]`, valid route entries, invalid prefix rejected, activation fields optional
- [ ] T019 [P] Extend `packages/cluster-relay/tests/relay.test.ts` — handshake includes activation when configured, omits when not configured, routes are pre-sorted

## Phase 7: Exports & Documentation

- [ ] T020 [P] Update `packages/cluster-relay/src/index.ts` to export `Actor`, `Activation`, `RouteEntry` types and dispatcher functions
- [ ] T021 [P] Update `packages/cluster-relay/README.md` with dispatcher config shape, route examples, actor header propagation, and activation usage

## Phase 8: Validation

- [ ] T022 Run full test suite (`pnpm test` in `packages/cluster-relay/`) and fix any failures
- [ ] T023 Run TypeScript type check (`pnpm tsc --noEmit`) and fix any type errors

## Dependencies & Execution Order

**Sequential dependencies:**
- T001 → T002 → T003 (schema → extension → export)
- T004 → T005 → T006 (route schema → config fields → loadConfig)
- T007 → T008, T009 (type + sort → resolve + utils)
- Phase 3 complete → T010, T011, T012 (dispatcher ready → proxy rewrite)
- Phase 2 + Phase 3 → T013, T014 (config + dispatcher → relay integration)
- Phases 1-5 complete → Phase 6 tests
- Phases 1-5 complete → T020, T021 (exports + docs)
- All above → T022, T023 (final validation)

**Parallel opportunities:**
- T001, T002, T003 are incremental but in the same file — best done sequentially
- T007 and T004 can start in parallel (different files)
- T009 can run parallel with T008 (independent functions in same file)
- All Phase 6 test tasks (T015-T019) can run in parallel (different test files)
- T020 and T021 can run in parallel (different files)
- T022 and T023 can run in parallel (different commands)
