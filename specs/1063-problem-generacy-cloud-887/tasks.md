# Tasks: Add `cluster.cockpit.reply` to `RelayMessageSchema`

**Input**: Design documents from `/specs/1063-problem-generacy-cloud-887/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md, research.md, data-model.md, quickstart.md, contracts/cluster-cockpit-reply.schema.json
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema

- [X] T001 [US2] Extend `packages/cluster-relay/src/messages.ts` with the new
  wire shape:
  1. Add `ClusterCockpitReplyMessage` interface next to the other 18 message
     interfaces (around `messages.ts:149`, after `TierInfoMessage`). Fields per
     spec FR-001: `type: 'cluster.cockpit.reply'`, `timestamp: string`,
     `frameId: string | null`, `frameType: string`, `gateId: string`,
     `gateKey?: string`, `accepted: boolean`, `reason?: string`,
     `priorStatus?: string`, `wroteDoc?: string`. `frameType` / `wroteDoc` /
     `reason` typed as `string` (Q2=A open — not closed enums).
  2. Add `ClusterCockpitReplyMessageSchema = z.object({ ... }).passthrough()`
     with `type: z.literal('cluster.cockpit.reply')`, matching field types
     above (`frameId: z.string().nullable()`). Add a comment above the schema
     documenting the currently-known values for `frameType`
     (`'gate-open' | 'gate-outcome' | 'unknown'`) and `wroteDoc`
     (`'created' | 'rebound'`) — informational only, not enforced (Q2=A).
     `.passthrough()` preserves unknown top-level fields (Q1=A / FR-002).
  3. Append `ClusterCockpitReplyMessageSchema` as the 19th entry in
     `RelayMessageSchema` at `messages.ts:360`. Append to end (not
     mid-insert) — discriminated-union order is not semantically meaningful.
  4. Extend the exported `RelayMessage` type union at `messages.ts:151-169` to
     include `ClusterCockpitReplyMessage`.

## Phase 2: Router
<!-- Sequential: Phase 1 must land first — Phase 2 references `message.type === 'cluster.cockpit.reply'` narrowing that only exists after the schema is added -->

- [X] T002 [US1] Add short-circuit branch in
  `packages/cluster-relay/src/relay.ts` inside `ws.on('message', ...)`,
  **after** the existing `api_request` short-circuit at `relay.ts:315-322`
  and **before** the `messageHandlers` fanout at `:324-331`. Placement must
  be **after** the two `authenticating → connected` transitions at
  `relay.ts:298-313` (same reasoning as `api_request` — a reply received
  during the auth window still promotes state). Shape per plan.md:

  ```ts
  if (message.type === 'cluster.cockpit.reply') {
    if (message.accepted) {
      this.logger.debug({ message }, 'cluster.cockpit.reply received');
    } else {
      this.logger.info(
        {
          reason: message.reason,
          frameType: message.frameType,
          gateId: message.gateId,
          priorStatus: message.priorStatus,
        },
        'cluster.cockpit.reply dropped',
      );
    }
    return;
  }
  ```

  The `return` is load-bearing (FR-003 / Q3=A) — it structurally prevents the
  message from reaching `messageHandlers` fanout, so a future handler cannot
  begin correlating before #1059 steps 4–7 are designed.

## Phase 3: Tests

- [X] T003 [P] [US2] Add parse-level cases to
  `packages/cluster-relay/tests/messages.test.ts`:
  - Parses a valid `cluster.cockpit.reply` with `accepted: true` and
    `wroteDoc: 'created'` — returns non-null.
  - Parses a valid `cluster.cockpit.reply` with `accepted: false` and
    `reason: 'invalid-payload'` — returns non-null.
  - **SC-003 passthrough**: feed a `cluster.cockpit.reply` with an extra
    `futureField: 'x'`; assert `parseRelayMessage` returns non-null AND that
    `futureField` is preserved on the returned object (not stripped).
  - **Q2=A open enums**: accepts an unrecognised `reason` string, an
    unrecognised `frameType`, and an unrecognised `wroteDoc` value.
  - **FR-008 bad-payload**: returns `null` when required `gateId` is missing
    from a `type: 'cluster.cockpit.reply'` payload — bad-payload signalling
    preserved via the existing `Invalid relay message, skipping` warn branch.

- [X] T004 [P] [US1] Add router-level cases to
  `packages/cluster-relay/tests/relay.test.ts` using the existing
  WebSocketServer test harness pattern:
  - **SC-001**: feed `cluster.cockpit.reply { accepted: true }`; assert
    zero `warn`-or-above lines on the pino logger spy. The only log line
    permitted is `debug`.
  - **SC-002**: feed `cluster.cockpit.reply { accepted: false, reason: '...' }`;
    assert exactly one `info`-or-above line whose payload includes `reason`,
    `frameType`, `gateId`, and (when present) `priorStatus`.
  - **FR-003 / Q3=A regression**: register a message handler via
    `onMessage(...)` and feed both variants; assert the handler is **not**
    invoked for `cluster.cockpit.reply`. Enforces the short-circuit
    structurally so a future subscriber cannot accidentally start
    correlating pre-#1059.

## Phase 4: Changeset

- [X] T005 [US1] Create `.changeset/1063-cluster-cockpit-reply.md` with a
  `minor` bump on `@generacy-ai/cluster-relay`. Content per plan.md:

  ```md
  ---
  '@generacy-ai/cluster-relay': minor
  ---

  Add `cluster.cockpit.reply` member to `RelayMessageSchema` so cloud-sent gate
  acknowledgements stop appearing as `Invalid relay message, skipping` warns.
  Observability-only; correlation deferred to #1059 steps 4–7.
  ```

  **Load-bearing**: `packages/cluster-relay/src/messages.ts` and
  `packages/cluster-relay/src/relay.ts` are non-test files under
  `packages/*/src/`, so the CI changeset gate
  (`.github/workflows/changeset-bot.yml`) will fail without this file.
  `minor` bump per CLAUDE.md's rule that a new wire-shape is a new capability.

## Phase 5: Verification

- [X] T006 [US1,US2] Run the full `packages/cluster-relay` test suite
  (`pnpm --filter @generacy-ai/cluster-relay test`) and verify:
  - All new cases from T003 and T004 pass.
  - **SC-004 regression**: all pre-existing `messages.test.ts` and
    `relay.test.ts` cases still pass unchanged. No existing test file
    should require an edit — the change is purely additive.
  - Verify **FR-007** by inspection: the 18 pre-existing
    `RelayMessageSchema` union members appear in the same order (only the
    19th appended entry is new) and no field was renamed or removed.

## Dependencies & Execution Order

**Sequential**:
- Phase 1 (T001) → Phase 2 (T002): the `if (message.type === 'cluster.cockpit.reply')`
  narrowing in `relay.ts` only compiles once the discriminated-union member is
  added in `messages.ts`.
- Phase 2 (T002) → Phase 3 (T003, T004): tests exercise both the schema and
  the router branch; router branch must exist before its tests can pass.
- Phase 3 → Phase 5 (T006): verification runs the tests written in Phase 3.

**Parallelizable**:
- T003 (messages.test.ts) and T004 (relay.test.ts) touch different files and
  have no data dependencies — mark `[P]`, safe to run concurrently.

**Ordering flexibility**:
- T005 (changeset) has no code dependencies and can be written any time
  after T001 lands. Listed in Phase 4 so it is not forgotten before commit
  — it is the single most common reason a speckit PR lands red per
  CLAUDE.md.
