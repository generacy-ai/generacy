# Tasks: cockpit_await_events lifecycle fix — bus survives between calls; cursors typed by lifetime

**Input**: Design documents from `/specs/924-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md, stack.md
**Status**: Implemented

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
  - **[US1]**: Sequential auto-session cursor reuse
  - **[US2]**: Correct cursor-lifetime classification across TTL eviction and process restart

## Phase 1: Foundational data-model changes (event-bus.ts nonce + cursor payload)

- [X] **T001** [US2] Add module-scoped `INSTANCE_NONCE` constant to `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts` — `const INSTANCE_NONCE: string = crypto.randomBytes(8).toString('hex')` at module scope; import `node:crypto`. (D2, R3)
- [X] **T002** [US2] Add `busNonce: string` field to `EpicEventBus` class in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts`. Extend `EpicEventBusOptions` with optional `nonce?: string` test seam; constructor assigns `this.busNonce = options.nonce ?? crypto.randomBytes(8).toString('hex')`. (data-model §"EpicEventBus internal state additions")
- [X] **T003** [US2] Widen `encodeCursor` signature to `encodeCursor(epic: string, position: number, pnonce: string, bnonce: string): string` in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts`; write `{ epic, position, pnonce, bnonce }` into the JSON payload. Update every internal call site to pass `INSTANCE_NONCE` and `this.busNonce`. (data-model §"Encoding")
- [X] **T004** [US2] Widen `decodeCursor` return type to `{ epic; position; pnonce?; bnonce? } | null` in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts`; validate `pnonce`/`bnonce` shape with `/^[0-9a-f]{16}$/` (bad shape → treat as absent per data-model §"Validation rules").
- [X] **T005** [US2] Extend `CursorParseResult` union in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts` to add `{ kind: 'discarded'; reason: 'legacy' | 'cross-instance' | 'evicted' }`. Export the new kind alongside existing kinds. (data-model §"Cursor classification")
- [X] **T006** [US2] Rewrite `parseCursor` classification order in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts` per data-model §"Classification order" (steps 1–10): missing nonce → `discarded/legacy`; wrong-epic; pnonce mismatch → `discarded/cross-instance`; bnonce mismatch → `discarded/evicted`; then position/expired/never-issued checks. Preserve `never-issued` only for same-instance, same-bus, out-of-range.

## Phase 2: Tool wiring (`cockpit_await_events.ts` + `schemas.ts`)

- [X] **T010** [US2] Add `'discarded'` branch to the cursor-kind switch in `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_await_events.ts` — sets `sinceCursor = 0`, `resetFrom = 'discarded'`, `status = 'ok'` (mirrors the existing `expired` branch). (contracts/cockpit_await_events.md classification table)
- [X] **T011** [US2] Widen `resetFrom` type in `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` (or wherever `CockpitAwaitEventsData` lives) from `'expired'` to `'expired' | 'discarded'`. Export the new union type. (data-model §"Tool output shape")
- [X] **T012** [US2] Update every output-cursor construction in `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_await_events.ts` to include both nonces via the widened `encodeCursor` (T003).

## Phase 3: Registry lifecycle (`event-bus-registry.ts`)

<!-- Phase boundary: T020–T027 all live in the same file; keep sequential to minimize merge conflicts. -->

- [X] **T020** [US1] Extend `Subscription` interface in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` with `pausePoller`, `resumePoller`, `catchUpPoll`, `idleTimer: NodeJS.Timeout | null`, `lastActiveAt: number` fields per data-model §"Registry data model".
- [X] **T021** [US1] Extend `AcquireOptions` in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` with test seams: `now?: () => number`, `idleTtlMs?: number`, `maxBuses?: number` per contracts/event-bus-registry.md.
- [X] **T022** [US1] Parse env vars `COCKPIT_MCP_BUS_IDLE_TTL_MS` (default `600_000`) and `COCKPIT_MCP_BUS_MAX` (default `100`) in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` using the same `Number.parseInt(process.env.X ?? '', 10) || DEFAULT` idiom used for `COCKPIT_MCP_EVENT_RETENTION_*`. Log `warn` once on parse failure.
- [X] **T023** [US1] Refactor `releaseKey` in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` to (a) decrement refcount, (b) if refcount → 0 arm `sub.idleTimer = setTimeout(evict, idleTtlMs)` and call `sub.pausePoller()`, (c) NOT delete the entry, NOT call `sub.stop()`. TTL callback runs `sub.stop(); registry.delete(key)`. (FR-001, FR-002, FR-003; data-model §"On release")
- [X] **T024** [US1] Refactor `acquireEpicBus` in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` for the existing-bus path per contracts/event-bus-registry.md §"On acquire — existing bus": clear `idleTimer`, increment refcount, update `lastActiveAt`, re-insert at map tail for LRU, `await sub.catchUpPoll()` if poller was paused, return.
- [X] **T025** [US1] Add LRU soft-cap eviction in the new-bus branch of `acquireEpicBus`: on `registry.size >= maxBuses`, evict `registry.keys().next().value` (`sub.stop(); registry.delete(evictedKey)`), then create the new bus. Log `warn` on eviction. (FR-007, R7)
- [X] **T026** [US1] Wire poller pause/resume/catch-up into `runPollLoop` (or the subscription factory) in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` per contracts/event-bus-registry.md §"Poller pause / resume / catch-up": internal `paused` flag on the loop closure retains `prev: SnapshotMap` and `aggState: AggregateState`; `catchUpPoll()` runs one `resolveEpic + runOnePoll + computeAggregateEvents` cycle and emits diffs to the bus. Best-effort — catches errors and logs via `options.logger.warn`. (FR-004, D4, R5)
- [X] **T027** [US1] Update `_resetRegistryForTests()` in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` to iterate every entry, `clearTimeout(sub.idleTimer)`, call `sub.stop()`, then `registry.clear()`. (contracts/event-bus-registry.md §"Test-only surface")

## Phase 4: Test coverage

<!-- Phase boundary: run after Phase 3 so the tests can exercise the new code paths. -->

- [X] **T030** [P] [US2] Extend `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus.test.ts`: nonce round-trip through `encodeCursor`/`decodeCursor`; `parseCursor` returns `discarded/legacy` for missing nonce, `discarded/cross-instance` for pnonce mismatch, `discarded/evicted` for bnonce mismatch, `never-issued` for same-instance same-bus out-of-range.
- [X] **T031** [P] [US2] Extend `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/await-events-cursor-classes.test.ts`: mismatched-nonce cursor yields `status: 'ok'` + `resetFrom: 'discarded'`; existing `never-issued` case (same nonce, out-of-range) still yields `invalid-cursor`.
- [X] **T032** [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus-registry.test.ts`: sequential `acquire`/`release`/`acquire` returns the same bus (refcount 0 keeps bus alive); nextCursor NOT reset. (SC-001)
- [X] **T033** [US1] Add idle-TTL fake-clock test to `event-bus-registry.test.ts`: `vi.useFakeTimers()`, advance past `idleTtlMs`, assert registry entry removed and a held cursor classifies as `discarded`.
- [X] **T034** [US1] Add TTL-clock arm/disarm invariant test to `event-bus-registry.test.ts`: assert `sub.refCount > 0 XOR sub.idleTimer != null` across `acquire` / `release` / `acquire` sequences. (R-I1)
- [X] **T035** [US1] Add poller-pause + catch-up test to `event-bus-registry.test.ts`: mock `runOnePoll` via `deps` seam, emit a synthetic event between two acquires, assert the second acquire's `catchUpPoll` delivers the event on the next `waitFor`. (SC-002, FR-004)
- [X] **T036** [US1] Add LRU-cap test to `event-bus-registry.test.ts`: with `maxBuses: 2`, acquire three distinct epics, assert the first (LRU) is evicted (`sub.stop()` called, registry.size stays at 2). Cursor from evicted bus classifies as `discarded`. (FR-007)
- [X] **T037** [P] [US2] Add legacy-cursor test to `await-events-cursor-classes.test.ts`: a cursor encoded WITHOUT `pnonce`/`bnonce` (pre-fix payload shape) yields `resetFrom: 'discarded'` on the first call. (FR-006)

## Phase 5: Polish & documentation

- [X] **T040** [P] Add structured log lines in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts`: `event-bus: catch-up poll` (info) on each catch-up run; `event-bus: LRU eviction` (warn) on LRU eviction; `event-bus: idle-TTL eviction` (info) on TTL fire. Grep-friendly, structured. (stack.md §"Observability")
- [X] **T041** [P] Verify env var docs live in the tunable's declaration comment in `event-bus-registry.ts` (`COCKPIT_MCP_BUS_IDLE_TTL_MS`, `COCKPIT_MCP_BUS_MAX`). No README update needed — repo convention is code-adjacent docs. (quickstart.md §"Environment variables")
- [X] **T042** [P] Run full `pnpm --filter=@generacy-ai/generacy test src/cli/commands/cockpit/mcp` and `pnpm --filter=@generacy-ai/generacy typecheck` — assert all tests green and no new type errors.

## Dependencies & Execution Order

**Sequential blocks**:
- Phase 1 (T001 → T002 → T003 → T004 → T005 → T006) — all in `event-bus.ts`; must land in order (T006's `parseCursor` rewrite depends on the union widened in T005, which depends on the encoded shape in T003 and the decoded shape in T004).
- Phase 2 depends on Phase 1 (`cockpit_await_events.ts` calls widened `encodeCursor`, imports the widened `CursorParseResult`).
- Phase 3 depends on Phase 1 (`event-bus-registry.ts` wires the `busNonce`-carrying bus and constructs cursors through the widened encoders).
- Phase 3 tasks T020–T027 are all in the same file; keep sequential to avoid merge churn.
- Phase 4 tests depend on Phases 1–3 landing.
- Phase 5 is polish, after Phase 4 green.

**Parallel opportunities**:
- T030, T031, T037 all touch distinct test files and can run in parallel once Phases 1–2 land.
- T040, T041, T042 are polish and can run concurrently.

**Story mapping**:
- **US1** (sequential cursor reuse) is fully covered by Phase 3 (registry lifecycle) + T032–T036 tests.
- **US2** (lifetime classification) is fully covered by Phase 1 (nonce + parseCursor) + Phase 2 (tool wiring) + T030, T031, T037 tests.

**Suggested next step**: `/speckit:implement` to begin execution.
