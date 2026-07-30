# Tasks: Mint a `frameId` per outbound cockpit frame and correlate `cluster.cockpit.reply` back to it

**Input**: Design documents from `/specs/1077-problem-after-generacy-1066/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/mint-route.md, contracts/pending-map.md, contracts/wire-response.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Landing order (from `quickstart.md`)

The consume half (`cluster-relay`) lands **first** because the orchestrator's
mint site consumes the new `registerPendingFrame` method — the interface must
exist before the route can call it.

```
Phase 1 (cluster-relay)  →  Phase 2 (orchestrator interface + route)
                        ↓
                 Phase 3 (integration test)
                        ↓
             Phase 4 (generacy wire schema)
                        ↓
                Phase 5 (changeset)
                        ↓
                Phase 6 (verification)
```

---

## Phase 1: Consume — cluster-relay pending map + settle/drop + TTL + comment cleanup

- [X] T001 [US2] Add `PendingFrame` (private) and `PendingFrameMeta` (exported)
  types to `packages/cluster-relay/src/relay.ts` per `data-model.md § E-1` and
  `contracts/pending-map.md § Public API added`. Include `frameType`, `gateId`,
  `registeredAt`, `ttlHandle` on `PendingFrame`; `frameType: 'gate-open' | 'gate-outcome'`
  and `gateId: string` on `PendingFrameMeta`. No exports for `PendingFrame`
  beyond internal use; `PendingFrameMeta` is re-exported from the package root.

- [X] T002 [US2] Add `private readonly pendingFrames = new Map<string, PendingFrame>()`
  and `private static readonly TTL_MS = 30_000` to the `ClusterRelay` class in
  `packages/cluster-relay/src/relay.ts`.

- [X] T003 [US2] Implement `registerPendingFrame(frameId: string, meta: PendingFrameMeta): void`
  on `ClusterRelay` in `packages/cluster-relay/src/relay.ts` per
  `contracts/pending-map.md § registerPendingFrame(frameId, meta) — behaviour`:
  empty `frameId` returns silently (with a `debug` line); existing entry for
  the same id clears the old timer and replaces the entry; otherwise stores a
  new `PendingFrame` with `registeredAt: Date.now()` and
  `ttlHandle: setTimeout(() => this.evictOnTtl(frameId), ClusterRelay.TTL_MS)`.
  Sync. Never throws. No log at register time.

- [X] T004 [US2] Implement `private evictOnTtl(frameId: string): void` on
  `ClusterRelay` in `packages/cluster-relay/src/relay.ts` per
  `contracts/pending-map.md § TTL — 30 seconds`: `get` + guard `!entry`, then
  `delete`, then log at `debug` with `{ frameId, ageMs }` under message
  `'cluster.cockpit pending frame evicted on TTL'`.

- [X] T005 [US2] Replace the `cluster.cockpit.reply` branch at
  `packages/cluster-relay/src/relay.ts:334-349` with the settle/quiet-drop
  logic from `contracts/pending-map.md § cluster.cockpit.reply handler`. Both
  branches log at **`info`**: settle uses `'cluster.cockpit.reply settled pending frame'`
  with `{ frameId, frameType, gateId, accepted, reason, priorStatus, ageMs }`;
  drop uses `'cluster.cockpit.reply had no matching pending frame'` with the
  same fields minus `ageMs`. Preserve the structural early `return` (FR-003 —
  pinned by `relay.test.ts:830`).

- [X] T006 [US4] Replace the comment at `packages/cluster-relay/src/relay.ts:330-333`
  with the block from `research.md § D-10`:

  ```ts
  // Cloud-sent gate acknowledgement (#1063 + #1077). #1077 wires the
  // frameId-keyed pending map: settle on match, quiet-drop on miss.
  // The return is structural (Q3=A / FR-003) — registered onMessage
  // handlers must not observe cluster.cockpit.reply.
  ```

  No occurrences of `#1059 steps 4-7` may remain (SC-007).

- [X] T007 [US2] Add pending-map cleanup to `disconnect()` in
  `packages/cluster-relay/src/relay.ts` per `contracts/pending-map.md § Shutdown / disconnect`:
  iterate `pendingFrames.values()`, `clearTimeout(entry.ttlHandle)` for each,
  then `pendingFrames.clear()`. **Silent** — no per-entry log. Do NOT add this
  cleanup to the `ws.on('close', ...)` handler at `:365-374` — transient
  disconnects must preserve the map so retained frames drained on reconnect
  still find their pending entries (see `contracts/pending-map.md § Reconnect
  invariant`).

- [X] T008 [US2] Add a test-only accessor `_pendingFramesSizeForTests(): number`
  (or `get pendingFrameCount(): number`) on `ClusterRelay` in
  `packages/cluster-relay/src/relay.ts` per `contracts/pending-map.md § Test surface`
  final paragraph. Prefer the `_ForTests` naming convention for parity with
  `_ENQUEUE_IF_ABSENT_SCRIPT_FOR_TESTS`.

- [X] T009 [US2] Rewrite the two `#1063` router-branch tests in
  `packages/cluster-relay/tests/relay.test.ts` per `contracts/pending-map.md § Test surface`:
  - `SC-001 accepted:true` — assert **`info`** with settle-line fields (was
    `debug`). Peer sends `frameId: <known-id>` after the test registers a
    matching pending entry via `relay.registerPendingFrame(...)`.
  - `SC-002 accepted:false` — assert **`info`** with unknown-drop-line fields,
    `frameId` in the payload (was absent). Peer sends `frameId: null` or an
    unregistered id.
  - `FR-003 handler exclusion` at `:830` — **unchanged**, must stay green.

- [X] T010 [US2] Add new `#1077 pending-frame correlation` describe block to
  `packages/cluster-relay/tests/relay.test.ts` per `contracts/pending-map.md § Test surface`:
  - `settle-then-evict`: register 3 frames, echo 3 replies, assert 3 `info`
    settle lines and `_pendingFramesSizeForTests() === 0` (SC-004).
  - `TTL eviction`: register 1 frame, `vi.useFakeTimers()` + advance 30s,
    assert 1 `debug` eviction line and size === 0.
  - `disconnect() clears map`: register 2 frames, `disconnect()`, assert
    `size === 0` and pending timers do not fire afterwards.
  - `transient reconnect preserves map`: register 1 frame, trigger `ws.close`
    (do NOT call `disconnect()`), wait for reconnect via `waitFor`, assert
    `size === 1` and the TTL timer is still live.

- [X] T011 [US2] Add `PendingFrameMeta` to the package's public exports in
  `packages/cluster-relay/src/index.ts` (or wherever the barrel export lives).
  Verify with `grep -n 'PendingFrameMeta' packages/cluster-relay/src/index.ts`.

---

## Phase 2: Mint — orchestrator interface + route + unit tests

- [X] T020 [US1] Add `registerPendingFrame(frameId: string, meta: PendingFrameMeta): void`
  to the `ClusterRelayClient` interface in `packages/orchestrator/src/types/relay.ts`
  per `data-model.md § E-2`. Import `PendingFrameMeta` from
  `@generacy-ai/cluster-relay`. Alphabetically place it near the other action
  methods (`send`, `on`, `off`, `disconnect`, `connect`) or immediately after
  `send` (register is the natural pair of send).

- [X] T021 [US1] Add the internal helper `mintFrameId()` to the top of
  `packages/orchestrator/src/routes/cockpit-gates.ts` per `data-model.md § E-3`:

  ```ts
  import { randomBytes } from 'node:crypto';

  function mintFrameId(): string {
    return `frm_${randomBytes(12).toString('hex')}`;
  }
  ```

  Not exported. Place near the existing `collapseCloudStatus` helpers.

- [X] T022 [US1] Wire the mint + register + emit for `POST /cockpit/gates`
  handler in `packages/orchestrator/src/routes/cockpit-gates.ts` per
  `contracts/mint-route.md § Behaviour` and `data-model.md § Route mutation shape`.
  After `GateOpenSchema.parse` at `:334`:

  ```ts
  const frameId = parsed.frameId ?? mintFrameId();
  const emitData = { ...parsed, frameId };
  options.getRelayClient()?.registerPendingFrame(frameId, {
    frameType: parsed.type,
    gateId: parsed.gateId,
  });
  // ... then tryEmitOrRetain with emitData ...
  ```

  Preserve invariant: **`registerPendingFrame` before `tryEmitOrRetain`** (see
  `contracts/mint-route.md § Ordering invariants`). Same `emitData` reference
  is passed to `tryEmitOrRetain` — do NOT clone.

- [X] T023 [US1] Wire the mint + register + emit for `POST /cockpit/gates/:id/ack`
  handler in `packages/orchestrator/src/routes/cockpit-gates.ts` — same pattern
  as T022, applied at `:413` (`GateOutcomeSchema.parse`) and `:416`
  (`tryEmitOrRetain` call). `frameType: parsed.type` is `'gate-outcome'`.

- [X] T024 [US1] Update the 202 response bodies for both handlers in
  `packages/orchestrator/src/routes/cockpit-gates.ts` per
  `contracts/wire-response.md § Response shape (both handlers)`:
  `{ accepted: true, retained, frameId, retainQueue? }`. `retainQueue` remains
  conditional on `retained === true` (unchanged). Existing 400 shape on
  validation failure is unchanged (no mint attempted before the validation
  gate).

- [X] T025 [US1] Extend `makeMockClient(...)` helpers in
  `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts:19-29`
  (and any other sites — grep `makeMockClient` under
  `packages/orchestrator/src/routes/__tests__/`) with a
  `registerPendingFrame: vi.fn()` field so existing tests compile against the
  widened `ClusterRelayClient` interface.

- [X] T026 [US1] Add unit tests to
  `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` per
  `contracts/mint-route.md § Test surface`:
  - POST `/cockpit/gates` with no `frameId` in body → 202 body has a
    `frm_[a-f0-9]{24}` `frameId`; `registerPendingFrame` invoked once with
    `(<same id>, { frameType: 'gate-open', gateId })`.
  - POST `/cockpit/gates` with caller-supplied `frameId: 'frm_wire_known'` →
    202 body carries that exact id verbatim; `registerPendingFrame` invoked
    with it (FR-011 override precedence).
  - POST `/cockpit/gates` with `frameId: null` → route mints (schema
    normalises `null` → `undefined`).
  - POST `/cockpit/gates` with `frameId: ''` → route mints (same normalisation).
  - Two consecutive POSTs with identical bodies → two **distinct** minted
    `frameId`s (FR-003 / SC-002).
  - Same matrix for POST `/cockpit/gates/:id/ack`.
  - Relay client returns `null` from `getRelayClient()` → 202 still carries a
    minted `frameId`; retainer receives an event with that id inside `data`
    (no throw, no `registerPendingFrame` invocation).

- [X] T027 [US1] Extend existing 202-body assertions across the test file to
  check `body.frameId` matches `/^frm_[a-f0-9]{24}$/` on all successful mints
  (both `retained: false` and `retained: true` paths). Guardrails against
  regressing existing scenarios silently.

---

## Phase 3: E2E integration — real WebSocket peer

- [X] T030 [US3] Extend
  `packages/orchestrator/src/__tests__/cockpit-gates-frameid.integration.test.ts`
  per `contracts/mint-route.md § Test surface` (integration section) and
  `research.md § D-9`:
  - POST without `frameId` → real relay peer receives a frame whose
    `data.frameId` matches `/^frm_[a-f0-9]{24}$/` (SC-001 baseline).
  - Peer echoes `cluster.cockpit.reply { frameId: <received id>, accepted: true }`
    → orchestrator's `cluster-relay` logger emits **one** `info` line
    (`'cluster.cockpit.reply settled pending frame'`) naming that `frameId`.
  - Peer echoes with a bogus `frameId: 'frm_ffff'` → **one** `info` line
    (`'cluster.cockpit.reply had no matching pending frame'`) naming that
    id; no throw; `_pendingFramesSizeForTests()` unchanged (SC-003).
  - Same coverage for `gate-outcome` via `POST /cockpit/gates/:id/ack`.

- [X] T031 [US3] Add a regression assertion to
  `packages/orchestrator/src/routes/__tests__/retained-cockpit-events.test.ts`
  (or extend the closest existing scenario) per `research.md § D-7` and SC-005:
  after a route mint under a null / disconnected relay client → retainer
  enqueue → `drainInto` → assert the drained frame's `data.frameId` equals the
  id echoed on the 202 response. Guards #1066 FR-008 preservation.

---

## Phase 4: Tool wire schemas — optional caller-supplied frameId

- [X] T040 [P] [US1] Add `frameId: z.string().min(1).optional()` to
  `GateOpenWireSchema` at
  `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:142` per
  `data-model.md § E-4`. Preserves the tool's own `safeParse` self-check when
  a caller supplies a `frameId`. Type impact only: `GateOpenWire` gains
  optional `frameId?: string`.

- [X] T041 [P] [US1] Add `frameId: z.string().min(1).optional()` to
  `GateOutcomeWireSchema` at `:193` in the same file per `data-model.md § E-4`.
  `GateOutcomeWire` gains optional `frameId?: string`.

- [X] T042 [US1] Add / extend schema regression tests in
  `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/schemas.test.ts`
  (or the closest existing file — grep for existing `GateOpenWireSchema`
  tests): `frameId: 'frm_abc'` accepted, `frameId: ''` rejected,
  `frameId: undefined` accepted (optional), no `frameId` field accepted. Same
  for `GateOutcomeWireSchema`. SC-006 (`grep -rn 'frameId' packages/generacy/src`
  returns non-zero) satisfied by this file alone.

---

## Phase 5: Changeset

- [X] T050 [US1][US2] Create `.changeset/1077-frameId-mint-consume.md` per
  `plan.md § Constitution Check`:
  - `@generacy-ai/cluster-relay` — **minor** (new public
    `registerPendingFrame` method + `PendingFrameMeta` export).
  - `@generacy-ai/orchestrator` — **patch** (internal route behaviour; no new
    public exports).
  - `@generacy-ai/generacy` — **patch** (optional wire-schema field addition).
  - `@generacy-ai/cockpit` — **no bump** (schema already carries `frameId`
    since #1066; regression tests only).

  Follow the `.changeset/*.md` shape used by adjacent changesets (see any
  existing `.changeset/*-*.md` for the frontmatter format). The file must be
  a **newly added** file per the CLAUDE.md changeset gate — editing an
  existing changeset does not satisfy CI.

---

## Phase 6: Verification

- [X] T060 [US1][US2] Run the SC-006 static check:

  ```bash
  grep -rn 'frameId' packages/generacy/src | wc -l
  ```

  Expected: **> 0** (was 0 pre-fix; T040/T041 satisfy this alone).

- [X] T061 [US4] Run the SC-007 static check:

  ```bash
  grep -n '#1059 steps 4-7' packages/cluster-relay/src/relay.ts
  ```

  Expected: **no output** (T006 removed the comment reference).

- [X] T062 [US1][US2][US3] Run the four package test suites and confirm
  100% green (SC-008 — no regression across pre-existing tests):

  ```bash
  pnpm --filter @generacy-ai/cockpit test
  pnpm --filter @generacy-ai/cluster-relay test
  pnpm --filter @generacy-ai/orchestrator test
  pnpm --filter @generacy-ai/generacy test
  ```

- [X] T063 [US1][US2] Confirm the changeset gate reads the new file:

  ```bash
  ls .changeset/1077-*.md
  cat .changeset/1077-*.md
  ```

  Verify each of the three bumped packages appears in the frontmatter with the
  correct level.

---

## Dependencies & Execution Order

**Sequential phase boundaries** (must complete Phase N before starting Phase N+1):
- Phase 1 (cluster-relay: new API) → **blocks** Phase 2 (orchestrator: consumes API)
- Phase 2 (route mint) → **blocks** Phase 3 (integration test drives real POSTs)
- Phase 3 (integration) → Phase 4 (schemas; independent but keep landing order)
- Phase 4 (schemas) → Phase 5 (changeset lists all affected packages)
- Phase 5 (changeset) → Phase 6 (verification runs after everything else)

**Within-phase parallelism**:
- Phase 1: T001 → T002 → T003, T004 sequential (same file). T005, T006, T007
  are non-conflicting edits to different regions of `relay.ts` — can be worked
  in sequence but each is independent code-wise. T009 and T010 (tests) can be
  developed in parallel after code lands.
- Phase 2: T020 (interface) must land before T022/T023 (route code); T025
  before T026 (mock needs the field). T026 and T027 touch the same file —
  work sequentially.
- Phase 4: T040 and T041 marked `[P]` — same file but disjoint regions
  (schemas.ts:142 vs :193); can be one commit or two.

**Cross-phase gotchas**:
- **Do NOT** land Phase 2 code without Phase 1's interface merged — the
  orchestrator will not compile.
- **Do NOT** rewrite the `#1063` tests (T009) with the old settle behaviour —
  the new behaviour is `info` in both branches, per `contracts/pending-map.md`
  and `research.md § D-4`. The load-bearing invariant (FR-003 short-circuit)
  stays green unmodified.
- **Do NOT** clone `emitData` inside `tryEmitOrRetain` — the shared reference
  is what carries `frameId` verbatim into the retainer queue, guarding FR-008.

---

## Summary

- **Total tasks**: 27 (T001–T011, T020–T027, T030–T031, T040–T042, T050,
  T060–T063).
- **Phase breakdown**:
  - Phase 1 (consume): 11 tasks.
  - Phase 2 (mint): 8 tasks.
  - Phase 3 (integration): 2 tasks.
  - Phase 4 (schemas): 3 tasks.
  - Phase 5 (changeset): 1 task.
  - Phase 6 (verification): 4 tasks.
- **Parallel markers**: T040 / T041 (`[P]`) — schemas.ts disjoint edits.
- **Mode**: Standard (fine-grained).
- **User-story coverage**: US1 (mint), US2 (consume), US3 (E2E), US4
  (comment cleanup) — all four stories have at least one code task and one
  test/verification task.

Next: `/speckit:implement` to begin execution.
