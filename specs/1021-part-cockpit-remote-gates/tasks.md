# Tasks: Cockpit Remote Gates — orchestrator side

**Input**: Design documents from `/specs/1021-part-cockpit-remote-gates/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: `[US1]` covers the whole scope — this issue delivers one contract surface, not per-user-story slices

## Phase 1: Setup

- [X] T001 Write the changeset **before** any `packages/*/src/` edit, per the CI gate in `CLAUDE.md#Changesets`. Create `.changeset/1021-cockpit-remote-gates.md` bumping `@generacy-ai/orchestrator` **minor** and `@generacy-ai/cockpit` **minor** (new capability). Must be a newly-added file — the gate checks `--diff-filter=A` against `origin/develop`. Copy the shape of a recent minor-bump changeset in `.changeset/`.

- [X] T002 Confirm `@generacy-ai/cockpit` is a workspace dep of `@generacy-ai/orchestrator` in `packages/orchestrator/package.json`. If not present, add it as `"@generacy-ai/cockpit": "workspace:*"` under `dependencies`. Run `pnpm install` to update the workspace lockfile. (Plan §Risks calls this out as an implement-time precheck.)

## Phase 2: Shared gate schemas (`@generacy-ai/cockpit`)

- [X] T010 [US1] Create `packages/cockpit/src/gates/schema.ts` with three Zod schemas from `data-model.md §1.1–§1.3`:
  - `GateOpenSchema` — `z.object({ kind: z.literal('gate-open'), gateId: z.string().min(1), generation: z.number().int().nonnegative(), scope: z.object({}).passthrough(), openedAt: z.string().datetime() }).passthrough()` (spec-level fields known + passthrough for `payload` and future epic-added fields; **do not** apply `.strict()` — orchestrator must forward-compat).
  - `GateAckSchema` — `z.object({ kind: z.literal('gate-ack'), gateId: z.string().min(1), generation: z.number().int().nonnegative(), outcome: z.string().min(1), ackedAt: z.string().datetime() }).passthrough()`.
  - `GateAnswerSchema` — `z.object({ kind: z.literal('gate-answer'), deliveryId: z.string().min(1), gateId: z.string().min(1), generation: z.number().int().nonnegative(), answeredAt: z.string().datetime(), answer: z.unknown() }).passthrough()`.
  - Export inferred TS types: `GateOpen`, `GateAck`, `GateAnswer`.

- [X] T011 [US1] Create `packages/cockpit/src/gates/index.ts` — barrel re-export of the schemas + types from `./schema.js`.

- [X] T012 [US1] Update `packages/cockpit/src/index.ts` to add `export * from './gates/index.js';`.

- [X] T013 [P] [US1] Add `packages/cockpit/src/gates/__tests__/schema.test.ts` covering: (a) each schema parses a canonical wire example from `quickstart.md`; (b) passthrough fields survive `parse()`; (c) missing/typed-wrong required fields produce a `ZodError` with the right `path`; (d) discriminator mismatch (`kind` wrong literal) rejects; (e) empty-string `gateId` / `deliveryId` rejects. Use `vitest`.

## Phase 3: Retention module + answers-file writer (`@generacy-ai/orchestrator`)

- [X] T020 [P] [US1] Create `packages/orchestrator/src/routes/retained-cockpit-events.ts` implementing the FIFO retainer per `data-model.md §2.1` and `research.md §1`:
  - `interface RetainedEvent { event: 'cluster.cockpit'; data: unknown; timestamp: string; approxBytes: number; }`
  - `createRetainedCockpitEvents({ maxCount, maxBytes }): { enqueue, drainInto, size, clear }` — pure factory; no module-scope singleton in the file itself (constructed in `server.ts` so tests inject caps).
  - `enqueue` returns `{ droppedCount }`; pops from head until under **both** caps.
  - `drainInto(client)` iterates head→tail, calls `client.send({ type: 'event', event: 'cluster.cockpit', data, timestamp })` per event, removes on success, stops on first synchronous throw. Returns `{ sent, failed }`.
  - **Do not** copy `retained-tunnel-event.ts` (single-slot). See research.md §1 for why.

- [X] T021 [P] [US1] Create `packages/orchestrator/src/routes/__tests__/retained-cockpit-events.test.ts` — asserts FIFO insertion order, count-cap overflow, byte-cap overflow, drop-oldest with `droppedCount` reported, `drainInto` sends in order and stops on throw, `size()` returns accurate `{ count, bytes }`, `clear()` empties.

- [X] T022 [P] [US1] Create `packages/orchestrator/src/services/cockpit-answers-writer.ts` implementing `CockpitAnswersWriter` per `data-model.md §2.2, §3.1` and `research.md §2, §3, §7`:
  - Constructor: `{ path, rotationBytes, rotationKeep, logger }` — env-var reads happen only in `server.ts` (research.md §8 test-seam).
  - `init()`: `fs.mkdir(dirname, { recursive: true, mode: 0o755 })`; `open` current file `O_CREAT | O_WRONLY | O_APPEND`, `chmod 0o644`; stream current file line-by-line, parse JSON, populate `Set<string>` keyed by `deliveryId`; skip malformed lines with `warn`; log `{ dedupSetSize }` at `info`. If file doesn't exist, no-op.
  - `hasDelivered(deliveryId): boolean`.
  - `append(payload)`: take async mutex; serialize `JSON.stringify(payload) + '\n'` in a single `fs.write(fd, buffer)`; `dedup.add(payload.deliveryId)`; check size against `rotationBytes`; if exceeded, run rotation inline; release mutex.
  - Rotation algorithm (research.md §2): if `.N` exists → unlink; for `i = N-1..1` promote `.i` → `.(i+1)` (if exists); rename current → `.1`; reopen new current at mode `0o644`; reset in-memory byte counter; log `{ event: 'cockpit-answers-rotated', keptSiblings: N }` at `info`. Dedup set is **not** reset.
  - `close()` for shutdown / test cleanup.
  - `EACCES` on `open` at `init()` throws — surfaced by `server.ts` as `ANSWERS_FILE_UNAVAILABLE` at boot; route returns `503`.

- [X] T023 [P] [US1] Create `packages/orchestrator/src/services/__tests__/cockpit-answers-writer.test.ts` using temp dirs (no env). Cover: fresh init (no file), init with existing file (dedup set repopulated), init tolerates malformed lines, append writes one line + trailing `\n`, dedup — same `deliveryId` twice → second `hasDelivered === true`, rotation at threshold cross, rotation retains exactly N siblings, rotation N=1 case, rotation displaces old `.N`, no partial-line writes under concurrent appends (fire N parallel appends, assert line count + no truncation).

## Phase 4: Routes

- [X] T030 [US1] Create `packages/orchestrator/src/routes/cockpit-gates.ts` exporting `setupCockpitGatesRoute(server, { retainer, getRelayClient, logger })`:
  - `POST /cockpit/gates` — per `contracts/post-cockpit-gates.md`. `GateOpenSchema.parse(request.body)`; on `ZodError` → `400 { error: 'Invalid gate-open payload', code: 'VALIDATION', details: err.issues }` + `warn`. Then either `client.send({ type: 'event', event: 'cluster.cockpit', data: parsed, timestamp: new Date().toISOString() })` (if `client && client.isConnected`) and respond `202 { accepted: true, retained: false }`, or `retainer.enqueue({...})` and respond `202 { accepted: true, retained: true, retainQueue: retainer.size() }`. Log `warn` if `droppedCount > 0`.
  - `POST /cockpit/gates/:id/ack` — per `contracts/post-cockpit-gates-ack.md`. **Pre-check**: if `request.body.gateId` present and `!== request.params.id` → `400 { code: 'VALIDATION', details: { pathGateId, bodyGateId } }`. Then merge `{ ...request.body, gateId: request.params.id }`, `GateAckSchema.parse(merged)`, same emit/retain path as `/cockpit/gates`.

- [X] T031 [P] [US1] Create `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` — inject a fake `retainer` and `getRelayClient`. Cover: happy path connected (calls `client.send` with correct wire shape from `cluster-cockpit-event.md`), happy path disconnected (enqueues), 400 on Zod fail, ack 400 on path/body mismatch, path/body merge when body omits `gateId`, `retainQueue` echoed in response, `warn` fires on overflow drops, order preserved when multiple posts arrive during a disconnect.

- [X] T032 [US1] Create `packages/orchestrator/src/routes/cockpit-answers.ts` exporting `setupCockpitAnswersRoute(server, { writer, logger })`:
  - `POST /cockpit/answers` — per `contracts/post-cockpit-answers.md`. `GateAnswerSchema.parse(request.body)`; on `ZodError` → `400 { code: 'VALIDATION', details }` + `warn`; **nothing written**. If `writer` is unhealthy (init failed) → `503 { code: 'ANSWERS_FILE_UNAVAILABLE' }`. If `writer.hasDelivered(deliveryId)` → `200 { accepted: true, deduped: true }` (no write). Otherwise `await writer.append(parsed)` → `200 { accepted: true, deduped: false }`.

- [X] T033 [P] [US1] Create `packages/orchestrator/src/routes/__tests__/cockpit-answers.test.ts` — inject a fake writer. Cover: fresh delivery appends, duplicate `deliveryId` returns `deduped: true` without touching writer.append, 400 on Zod fail with no write, 503 when writer unhealthy, `deliveryId` collision across multiple in-flight requests (writer's mutex serializes).

## Phase 5: Wiring

- [X] T040 [US1] Modify `packages/orchestrator/src/routes/internal-relay-events.ts` — add `'cluster.cockpit'` to `ALLOWED_CHANNELS` (the tuple at ~lines 9-15). One-line edit; no structural change. This is defensive per `contracts/cluster-cockpit-event.md#Allow-list` — direct emits bypass this file, but future refactors that route via `/internal/relay-events` remain valid.

- [X] T041 [US1] Modify `packages/orchestrator/src/services/relay-bridge.ts`: in the `handleConnected()` path (~lines 227-245, right after `replayRetainedTunnelEvent(this.client)`), also call `retainedCockpitEvents.drainInto(this.client)` (import the retainer instance passed in via constructor DI — parallel to how the tunnel retainer is threaded). Additive only. Log `{ sent, failed }` at `debug`.

- [X] T042 [US1] Modify `packages/orchestrator/src/server.ts` with four edits (order matters — all **before** `server.listen()`, per #598 pattern):
  1. **Env reads**: read `COCKPIT_INTERNAL_API_KEY`, `COCKPIT_ANSWERS_FILE` (default `/workspaces/.generacy/cockpit/answers.ndjson`), `COCKPIT_ANSWERS_ROTATION_BYTES` (default `33554432`), `COCKPIT_ANSWERS_ROTATION_KEEP` (default `3`), `COCKPIT_RETAIN_MAX_COUNT` (default `1000`), `COCKPIT_RETAIN_MAX_BYTES` (default `4194304`).
  2. **API key registration** (~lines 780-790, in the same block as `ORCHESTRATOR_INTERNAL_API_KEY`): if `cockpitKey` present, `apiKeyStore.addKey(cockpitKey, { name: 'cockpit-internal', scopes: ['admin'], createdAt: new Date().toISOString() })`; else `server.log.warn('COCKPIT_INTERNAL_API_KEY not set — cockpit gate routes will reject all requests')`.
  3. **Writer + retainer construction**: `const cockpitWriter = new CockpitAnswersWriter({ path, rotationBytes, rotationKeep, logger: server.log }); await cockpitWriter.init().catch(err => { server.log.error({ err }, 'cockpit-answers-writer init failed'); cockpitWriter.markUnhealthy(); });` — mark unhealthy so the route returns 503 instead of throwing. `const cockpitRetainer = createRetainedCockpitEvents({ maxCount, maxBytes });`.
  4. **Route wiring**: call `setupCockpitGatesRoute(server, { retainer: cockpitRetainer, getRelayClient: () => relayClientRef, logger: server.log })` and `setupCockpitAnswersRoute(server, { writer: cockpitWriter, logger: server.log })` before `server.listen()` — same deferred-binding pattern as `setupInternalRelayEventsRoute` (#598) so wizard-mode background activation works. Thread `cockpitRetainer` into the `RelayBridge` constructor so T041's `drainInto` call has the right reference.

- [X] T043 [US1] Verify (search only, no code change) that `packages/orchestrator/src/middleware/auth-middleware.ts`'s `skipRoutes` does **not** include `/cockpit/*`. Per Q4→C, gate routes inherit `authMiddleware` by default — adding them to `skipRoutes` would break the security model. If a prior refactor added `/cockpit`, remove it.

- [X] T044 [US1] Verify (search only) that `initializeRelayBridge()` in `server.ts` (~lines 1338-1347) does **not** grow a `/cockpit` route entry, per Q5→A. The implicit `orchestratorUrl` fallback in `packages/cluster-relay/src/proxy.ts:166-168` already delivers `POST /cockpit/answers` to the orchestrator with the full path preserved. Emitting a route entry would force renaming Fastify route to `/answers` and break the contract.

## Phase 6: Verification

- [X] T050 [US1] Run `pnpm -w -F @generacy-ai/cockpit test -- --run` and `pnpm -w -F @generacy-ai/orchestrator test -- --run`. All new tests green. Existing tests unchanged (no regressions in `internal-relay-events`, `retained-tunnel-event`, or `relay-bridge` suites).

- [X] T051 [US1] Run the local smoke test from `quickstart.md`:
  1. Set `COCKPIT_INTERNAL_API_KEY` in the orchestrator container.
  2. `curl POST /cockpit/gates` (open) → `202 { retained: false }` when relay connected.
  3. `curl POST /cockpit/gates/:id/ack` → `202 { retained: false }`.
  4. `curl POST /cockpit/answers` fresh → `200 { deduped: false }`.
  5. Repeat #4 with same `deliveryId` → `200 { deduped: true }`.
  6. `tail /workspaces/.generacy/cockpit/answers.ndjson` — exactly one line for the smoke test.
  7. Bounce the relay (disconnect + reconnect) between #2 and #3 to observe `retained: true` on the ack, then verify the `debug` log line `retained cockpit event queued` and the drain on reconnect.

- [X] T052 [US1] Verify the CI changeset gate: `git diff --diff-filter=A origin/develop -- .changeset/` includes the T001 changeset file. `pnpm changeset status` (without `--since=origin/develop`) lists the bumps for `@generacy-ai/orchestrator` and `@generacy-ai/cockpit`.

## Dependencies & Execution Order

**Serial anchors** (must land in order):

1. **T001 → everything else** — CI gate rejects the PR without the changeset. Write it first, not last.
2. **T002 → T030, T032, T042** — orchestrator can't import from `@generacy-ai/cockpit` until the workspace dep is declared.
3. **T010 → T011 → T012 → T030, T032** — routes import the schemas.
4. **T020 → T041, T042** — RelayBridge and server wiring need the retainer factory.
5. **T022 → T032, T042** — answers route + server need the writer class.
6. **T030 + T032 + T040 + T041 → T042** — server wires all the pieces last.
7. **T042 → T050 → T051 → T052** — tests + smoke need the wiring in place.

**Parallel-eligible groups**:

- **Schema tests** [P]: T013 runs independently of T020/T022.
- **Retainer + writer** [P]: T020, T022, T021, T023 all touch different files — the whole retainer track (T020, T021) can run in parallel with the whole writer track (T022, T023).
- **Route tests** [P]: T031, T033 run independently of T042 (they inject fakes).
- **Verification lookups** [P]: T043, T044 are search-only sanity checks; run at any time after T042.

**Recommended execution wave order** (for a solo implementer):

1. T001, T002 (setup) — 1 wave.
2. T010, T011, T012 (schemas) — sequential within, but T013 parallel to phase 3 start.
3. T020 + T021 || T022 + T023 (retainer + writer in parallel tracks) — 1 wave, 2 parallel tracks.
4. T030 + T031 || T032 + T033 (routes in parallel tracks) — 1 wave, 2 parallel tracks.
5. T040, T041, T042 (wiring, sequential) — 1 wave.
6. T043 + T044 (parallel sanity checks) + T050, T051, T052 (verification) — 1 wave.

## Notes for `/speckit:implement`

- **Test-first not enforced** — plan.md doesn't mandate TDD, and the schemas + writer are easier to write against a live shape. Tests land in the same wave as their production files.
- **No UI to smoke** in this PR (cloud UI + doorbell are separate epic issues). Smoke test is `curl` + `tail`.
- **`.strict()` on Zod is a trap here** — the epic contract explicitly allows forward-compat fields. Use `.passthrough()` on the outer object; the plan calls this out in data-model.md §1.1.
- **Do not merge retention modules** — `retained-tunnel-event.ts` is single-slot with terminal/pending semantics; `retained-cockpit-events.ts` is FIFO with count/bytes caps. Zero shared code. See research.md §1.
