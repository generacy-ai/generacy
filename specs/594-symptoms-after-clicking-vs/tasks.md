# Tasks: Control-plane relay event IPC channel

**Input**: Design documents from `/specs/594-symptoms-after-clicking-vs/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Orchestrator endpoint

- [X] T001 [US1] Create `packages/orchestrator/src/routes/internal-relay-events.ts` — Zod schema (`RelayEventRequestSchema`: `{ channel: z.enum([...]), payload: z.unknown() }`) and Fastify route handler that validates body, calls `relayClient.send({ type: 'event', channel, event: payload })`, returns 204
- [X] T002 [US1] Register route and API key in `packages/orchestrator/src/server.ts` — Read `ORCHESTRATOR_INTERNAL_API_KEY` from env, add to `apiKeyStore` (name: `'control-plane-internal'`, follows `relayInternalKey` pattern at ~line 628), register `POST /internal/relay-events` with auth preHandler, pass `relayClient` to handler
- [X] T003 [P] [US1] Unit test `packages/orchestrator/src/routes/__tests__/internal-relay-events.test.ts` — Test schema validation (valid channel, invalid channel, missing payload), mock `relayClient.send`, verify 204 response and correct `EventMessage` shape, verify auth rejection without key

## Phase 2: Control-plane wiring

- [X] T004 [US1] Wire `setRelayPushEvent()` in `packages/control-plane/bin/control-plane.ts` — Read `ORCHESTRATOR_INTERNAL_API_KEY` and `ORCHESTRATOR_URL` (default `http://127.0.0.1:3100`) from env. If key present, call `setRelayPushEvent()` with callback that uses `fetch()` to POST `{ channel, payload }` to `/internal/relay-events` with Bearer auth. If key absent, log warning.
- [X] T005 [P] [US1] Unit test `packages/control-plane/__tests__/relay-event-ipc.test.ts` — Test that `setRelayPushEvent` callback makes correct HTTP request (mock `fetch`), test graceful degradation when key is unset, test error logging on fetch failure

## Phase 3: Integration verification

- [X] T006 [US1][US2][US3] Manual integration test — Build both packages, verify with `grep -r 'setRelayPushEvent' packages/control-plane/bin/` that the call site exists, run `pnpm build` to confirm no type errors, verify the three event channels (`cluster.vscode-tunnel`, `cluster.audit`, `cluster.credentials`) will flow through the new IPC path

## Dependencies & Execution Order

- **T001** and **T003** can start in parallel (T003 tests the handler in isolation with mocks)
- **T002** depends on T001 (registers the handler created in T001)
- **T004** is independent of T001-T002 (control-plane side only touches `bin/control-plane.ts` and `relay-events.ts`)
- **T004** and **T003** can run in parallel with T001→T002
- **T005** depends on T004
- **T006** depends on all previous tasks

```
T001 ──► T002 ──┐
  │              │
  ├── T003 [P]  ├──► T006
  │              │
T004 ──► T005 ──┘
```

**Note**: FR-004 (entrypoint generates ephemeral UUID key) is a companion change in the `cluster-base` repo — not tracked here. Without it, `ORCHESTRATOR_INTERNAL_API_KEY` is unset and control-plane degrades gracefully (FR-005).
