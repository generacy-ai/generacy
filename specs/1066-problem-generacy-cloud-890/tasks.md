# Tasks: Thread `frameId` through `GateOpenSchema` / `GateOutcomeSchema` and orchestrator route

**Input**: Design documents from `/specs/1066-problem-generacy-cloud-890/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = cloud correlation, US2 = route strict-boundary)

## Phase 1: Wire schema — cockpit package (source of truth)

- [X] T001 [US1] Add optional `frameId` field to `GateOpenSchema` in `packages/cockpit/src/gates/schema.ts` (around line 53).
  Shape (verbatim from plan / data-model / research Decision 1):
  ```ts
  frameId: z
    .union([z.string().min(1), z.literal('').transform(() => undefined)])
    .optional(),
  ```
  Place it as the last field of the object literal. Add one short trailing comment referencing
  `#1066` and the cloud read-site `services/api/src/services/relay/message-handler.ts:804`
  (per plan §Constitution Check "no comments except for non-obvious 'why'"). Do **not** add
  `.strict()` or `.passthrough()` to the schema — the fix is the new field, not a mode change.

- [X] T002 [US1] Add the same optional `frameId` field to `GateOutcomeSchema` in
  `packages/cockpit/src/gates/schema.ts` (around line 77).
  Use the exact same union-with-transform shape from T001. One short trailing comment
  ("Same shape and rationale as GateOpenSchema.frameId — #1066") is enough; do not repeat
  the read-site reference.

- [X] T003 [P] [US1] Extend `GateOpenFixtureOverrides` and `GateOutcomeFixtureOverrides` in
  `packages/cockpit/src/gates/wire-fixtures.ts` with an optional `frameId?: string` field.
  Verify the `gateOpenFixture` / `gateOutcomeFixture` builder functions spread overrides
  last so `overrides.frameId` reaches the output when set; if the spread order does not
  already carry `frameId` through, adjust it. Default (no-override) output must remain
  `frameId`-free (per research Decision 6). Do NOT modify `packages/cockpit/src/gates/fixtures.ts`
  — `VALID_FIXTURES` / `VALID_ACK_FIXTURES` / `VALID_ANSWER_FIXTURES` stay unchanged.

## Phase 2: Cockpit-side unit tests (SC-003)

- [X] T004 [US1] Add a new `describe('frameId', ...)` block to
  `packages/cockpit/src/__tests__/gates-schemas.test.ts` covering the 4-cell matrix for
  **both** `GateOpenSchema` and `GateOutcomeSchema`:
    1. non-empty string (`"frm_abc"`) → present on parsed object with the same value.
    2. omitted (key not in input) → `'frameId' in parsed === false` (or `parsed.frameId === undefined`
       AND `Object.hasOwn(parsed, 'frameId') === false` after `JSON.parse(JSON.stringify(parsed))`
       — pick whichever assertion the existing test file conventions use).
    3. `""` (empty string) → normalized to absent (same assertion shape as case 2).
    4. non-string (`123`, `null`, `{}`, `[]`) → `.safeParse` returns `success: false` with a
       ZodError; assert at least one non-string case.
  Reuse existing valid base fixtures from `packages/cockpit/src/gates/fixtures.ts` and add
  `frameId` via object spread on the test side rather than editing the fixtures file.

## Phase 3: Orchestrator route + retainer tests (SC-002, SC-004, SC-005)

- [X] T005 [P] [US1, US2] Extend `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts`
  with the following assertions against both `POST /cockpit/gates` (gate-open) and
  `POST /cockpit/gates/:id/ack` (gate-outcome):
    - Caller supplies `frameId: '<known>'` → outbound frame's `data.frameId === '<known>'`
      (byte-for-byte). Assert against the argument recorded by whatever spy the existing
      tests use for the relay client send.
    - Caller omits `frameId` → `'frameId' in outboundFrame.data === false`. (SC-002)
    - Caller supplies `frameId: ''` → `'frameId' in outboundFrame.data === false` (normalized).
    - Caller supplies `frameId: 123` (number) → route returns 400 VALIDATION (existing
      Zod-error → 400 mapping at `cockpit-gates.ts:340-350` / `:419-429` covers this).
  Do NOT switch the route to forward `request.body` — the tests must still confirm the route
  forwards a Zod-*parsed* object (US2 / FR-005). Match the assertion style of the
  neighbouring outbound-shape tests in the same file.

- [X] T006 [P] [US1] Extend
  `packages/orchestrator/src/routes/__tests__/retained-cockpit-events.test.ts` with a
  retention → drain assertion (SC-005):
    - Enqueue two events into the retainer: one with `data.frameId = 'frm_kept'`, one without.
    - Drain into a spy client.
    - Assert the drained frames match the enqueued `data` byte-for-byte — the frame with
      `frameId` still carries it, the frame without does not gain one.
  Zero source-file change on `retained-cockpit-events.ts` (per plan Decision 4 — the drain
  path already passes `head.data` verbatim). If the existing test file has no drain-fixture
  helper, add a minimal one inline; do not refactor unrelated tests.

## Phase 4: Real-WebSocket integration test (SC-001, load-bearing)

- [X] T007 [US1] Create NEW file
  `packages/orchestrator/src/__tests__/cockpit-gates-frameid.integration.test.ts`.
  Follow the pattern from `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts`
  (#1024 precedent) and `packages/cluster-relay/tests/relay.test.ts` (parent template):
    - Spin up a real `ws` `WebSocketServer` on `{ port: 0 }` (random port) as a fake relay peer.
    - Boot the orchestrator's cockpit-gates route + `ClusterRelayClient` (or the Relay Bridge)
      pointed at `ws://127.0.0.1:<port>`.
    - `waitFor(client.isConnected)` before the POST so the frame goes to the wire, not the
      retainer (per quickstart.md Troubleshooting §"The integration test hangs"). Add a
      timeout so failures surface as errors, not hangs.
    - `POST /cockpit/gates` with a valid body including `frameId: '<known>'`.
    - Await the peer's next received message. Assert:
      `received.event === 'cluster.cockpit'`,
      `received.data.type === 'gate-open'`,
      `received.data.frameId === '<known>'` (this is the wire-level assertion; the
      envelope-level position — `received.frameId` — MUST NOT be asserted, since the
      cloud only reads `data.frameId`; per SC-001 rider and research Decision 2).
    - Include one negative counterpart: a POST without `frameId` → assert
      `'frameId' in received.data === false`.
  A `vi.fn()` echoing its own argument does **not** satisfy SC-001. Per-scenario teardown
  must close the peer and the client (see the cleanup pattern in the #1024 precedent test).

## Phase 5: Changeset (CI gate)

- [X] T008 Create NEW file `.changeset/1066-frame-id-wire.md`. Contents:
  ```markdown
  ---
  "@generacy-ai/cockpit": minor
  "@generacy-ai/orchestrator": patch
  ---

  Preserve caller-supplied `frameId` on `GateOpenSchema` / `GateOutcomeSchema` and
  the orchestrator cockpit-gates route so `cluster.cockpit.reply` correlation
  (generacy-cloud#890) stops collapsing onto `(gateId, frameType)` on idempotent
  retries. Additive-optional wire-schema field; older callers unaffected.
  ```
  Bump rationale (from research Decision 7): cockpit **minor** = new capability on the
  public wire contract (downstream consumers can now write `frameId`). Orchestrator **patch**
  = internal behavior change, no new public exports, defect-fix category. Single file
  covers both packages per CLAUDE.md changeset gate.

## Phase 6: Verification

- [X] T009 Run `pnpm --filter @generacy-ai/cockpit test` — must be green (covers T004 / SC-003
  and the pre-existing cockpit suites for SC-004 no-regression).

- [X] T010 Run `pnpm --filter @generacy-ai/orchestrator test -- cockpit-gates` — must be green
  (covers T005 / SC-002, T006 / SC-005, and the pre-existing orchestrator cockpit-gates
  suites for SC-004 no-regression).

- [X] T011 Run `pnpm --filter @generacy-ai/orchestrator test -- cockpit-gates-frameid.integration`
  — must be green (covers T007 / SC-001, the load-bearing wire-level assertion).

- [X] T012 Sanity-check the changeset gate: verify `.changeset/1066-frame-id-wire.md` is a
  newly *added* file in the diff (not an edit of an existing one — the CI gate greps
  `--diff-filter=A`), lists both `@generacy-ai/cockpit` and `@generacy-ai/orchestrator`, and
  the bumps match Decision 7.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 & T002 (schema changes) → T004 (cockpit unit tests need the new schema field)
- T001 & T002 (schema changes) → T005, T006, T007 (orchestrator tests exercise the schema through the route)
- T003 (fixture overrides) → T007 if the integration test opts in to the fixture helpers (otherwise T003 and T007 are independent)
- All implementation tasks (T001–T008) → T009–T012 (verification)

**Parallel opportunities**:
- T001, T002, T003 are three independent edits to the cockpit package — safe to run in parallel.
- T005 (cockpit-gates route tests), T006 (retained-cockpit-events tests) touch different
  test files — safe in parallel after T001+T002 land.
- T009, T010, T011 are three independent `pnpm test --filter` invocations — safe in parallel.

**Critical path**:
`(T001 + T002) → T004 → (T005 || T006) → T007 → T008 → (T009 || T010 || T011) → T012`

## Notes

- **No `packages/claude-plugin-cockpit/commands/*.md` playbook edits** in this issue — spec,
  plan, and issue body reference zero such paths. No `playbook-verification.test.ts` re-pin
  task is required (per /tasks playbook-coupling verification rule; permissive bias
  confirmed by grep).
- **No source-file changes** to `packages/orchestrator/src/routes/cockpit-gates.ts`,
  `packages/orchestrator/src/routes/retained-cockpit-events.ts`, or
  `packages/cluster-relay/src/messages.ts` — the route already forwards `parsed`, the
  retainer already passes `head.data` verbatim, and the envelope stays as-is (plan
  Decisions 3, 4, and §Constraints & Risks trap).
- **Behavior-change is entirely carried by the schema widening** in T001/T002; the rest of
  the task list is tests + changeset. This is what makes the change safe to land alone
  (spec §Why this is safe to land alone).

## Next step

Run `/speckit:implement` to execute this task list.
