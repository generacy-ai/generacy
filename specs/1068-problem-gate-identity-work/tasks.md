# Tasks: End-to-end verification of run-scoped gate identity

**Input**: Design documents from `/specs/1068-problem-gate-identity-work/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/{fake-cloud-store,fake-peer-payload-schema,mcp-tool-driver,production-code-boundary,revert-scenarios}.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story / functional requirement the task belongs to

## Phase 1: Setup / preconditions

- [ ] T001 Run the sibling harness to establish a green baseline:
  `pnpm --filter @generacy-ai/orchestrator test cockpit-gates-integration.integration.test.ts`
  and `pnpm --filter @generacy-ai/orchestrator test cockpit-gates-frameid.integration.test.ts`.
  Both must pass before starting; the new file extends the same scaffolding (plan §Approach, research §Implementation patterns).

- [ ] T002 Resolve D-2 (MCP tool driver import path). Attempt D-2-a (direct TypeScript import
  from `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_*.ts` inside a test
  under `packages/orchestrator/src/__tests__/`) with a throwaway one-liner test. If
  `pnpm --filter @generacy-ai/orchestrator test` resolves the imports, record "D-2-a" in a comment
  atop `mcp-tool-driver.ts`. If not, fall back to D-2-b (Node subprocess mirroring the doorbell
  driver). Decision must be pinned before T006. (research §D-2, contracts/mcp-tool-driver.md §Implementation)

- [ ] T003 Resolve D-3 (`GateOpenWireSchema` / `GateOutcomeWireSchema` import location).
  Attempt D-3-a (test-time import from `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`)
  first — zero cost if the workspace resolver accepts it. If not, apply D-3-b (duplicate the two
  schemas inline in `fake-peer.ts`, ~30 LOC, matches the mirror-pattern the cluster-side schemas
  already use). D-3-c (extract to `@generacy-ai/cockpit`) is deferred as a follow-up — it triggers
  the changeset gate and widens PR scope. Decision must be pinned before T005.
  (research §D-3, plan §"Files touched")

## Phase 2: Harness helpers (foundation for every FR test)

<!-- Phase boundary: T001–T003 must land before Phase 2. Phase 2 helpers unblock every Phase 3 test. -->

- [ ] T004 [P] Create `packages/orchestrator/src/__tests__/cockpit-gates/fake-cloud-store.ts` — new file.
  Implements `createFakeCloudStore({ persistGeneration? })` returning a `FakeCloudStore` with
  `putGateFromWireFrame(payload)`, `applyOutcome(gateId, outcome, detail?)`, `putRaw(doc)`,
  `getByKey(issueRef, gateType, generation, runId?)`, `listByIssueRef(issueRef, gateType?)`,
  and a readonly `all` inspector. `getByKey` MUST derive its lookup key via
  `deriveGateKey` + `deriveGateId` from `@generacy-ai/cockpit` — same helpers the tool uses (D-5
  invariance). `putGateFromWireFrame` drops `generation` when `persistGeneration === false`
  (Phase A revert cell). `putRaw` bypasses derivation (FR-009 pre-Phase-A doc). No status filter
  in `listByIssueRef` — the orchestrator route applies its own collapse. (data-model §E1, §E2,
  contracts/fake-cloud-store.md)

- [ ] T005 Extend `packages/orchestrator/src/__tests__/cockpit-gates/fake-peer.ts` — modify existing file.
  Add payload validation inside the `msg.type === 'event' && msg.event === 'cluster.cockpit'`
  branch (currently `fake-peer.ts:148-158`): dispatch on `msg.data.type`, running
  `GateOpenWireSchema.safeParse(msg.data)` for `'gate-open'` and `GateOutcomeWireSchema.safeParse(msg.data)`
  for `'gate-outcome'`. On success push to `received.events` AND (if an `onValidatedFrame` callback
  is wired) forward the parsed payload. On failure push
  `{ frameType, gateId?, issues }` to a new `payloadViolations` array on the `FakePeer` interface,
  do NOT push to `received.events`, do NOT crash. Extend `FakePeerOptions` with
  `onValidatedFrame?: (frame) => void`. Schema import per T003 decision.
  (data-model §E3, contracts/fake-peer-payload-schema.md)

- [ ] T006 [P] Create `packages/orchestrator/src/__tests__/cockpit-gates/mcp-tool-driver.ts` — new file.
  Implements `createMcpToolDriver({ baseUrl, fetchImpl? })` returning a `McpToolDriver` with
  `gateOpen`, `gateAck`, `gateStatus`, `gateList` methods. Each delegates to the corresponding
  handler (`cockpitGateOpen`, `cockpitGateAck`, `cockpitGateStatus`, `cockpitGateList`) with
  `{ baseUrl, fetchImpl: fetchImpl ?? fetch }` as deps. Import path per T002 decision (D-2-a
  direct import or D-2-b subprocess wrapper). Returns raw `ToolResult<T>` — scenarios explicitly
  check `.status === 'ok'` before reading `.data`. No retry, no MCP protocol, no `claude` process.
  (data-model §E4, contracts/mcp-tool-driver.md)

- [ ] T007 Extend `packages/orchestrator/src/__tests__/cockpit-gates/scenario-helpers.ts` — modify existing file.
  Add `startFakeCloud?: boolean` and `fakeCloudOptions?: FakeCloudStoreOptions` to `setupScenario`'s
  options. When `startFakeCloud: true`:
  1. Instantiate `fakeCloud = createFakeCloudStore(opts.fakeCloudOptions)`.
  2. Wire `onValidatedFrame` callback on the `FakePeer` to route into
     `fakeCloud.putGateFromWireFrame` / `fakeCloud.applyOutcome` per frame type.
  3. Build a `httpRequestImpl` shim that matches
     `GET /api/clusters/<clusterId>/cockpit/gates?...`, parses the query string, and returns JSON
     from `FakeCloudStore.getByKey` (status mode) or `.listByIssueRef` (list mode). Shape per
     `cloud-gate-query-client.ts:78-114`. List-mode entries with `generation: undefined` emit
     `generation: '<pre-phase-a>'` sentinel.
  4. Construct `CloudGateQueryClient` via `createCloudGateQueryClient({ clusterId: 'test-cluster', httpRequestImpl: shim })`.
  5. Pass `getCloudGateQueryClient: () => cloudGateQueryClient` into `setupCockpitGatesRoute`.
  6. Swap the current `SILENT_LOGGER` for a new `CountingLogger` (define inline in
     `scenario-helpers.ts` per data-model §E6) that captures every info/warn record;
     expose the array as `ctx.gateEmittedLogLines` filtered on `msg === 'cockpit gate emitted'`.
  7. Instantiate `mcp = createMcpToolDriver({ baseUrl: orchestratorUrl, fetchImpl: fetch })`.
  8. Set `GENERACY_API_URL=http://127.0.0.1:1` (ignored by the shim; restored at cleanup).
  Extend `ScenarioContext` with `fakeCloud`, `mcp`, `gateEmittedLogLines` (all optional / null
  when `startFakeCloud` is not set). Cleanup restores env var. (data-model §E5, §E6, plan §Approach 2)

## Phase 3: FR verification tests

<!-- Phase boundary: T004–T007 must land before Phase 3. Each Phase 3 test uses setupScenario({ startFakeCloud: true }). -->

- [ ] T008 Create `packages/orchestrator/src/__tests__/cockpit-gates-runid.integration.test.ts` — new file
  with the top-level scaffolding: `describe.each` matrix from `contracts/revert-scenarios.md §CI matrix realization`
  with three cells (`healthy`, `phase-A-reverted`, `phase-B-reverted`; phase-C omitted per the doc's rationale),
  per-scenario `beforeEach` calling `setupScenario({ startFakeCloud: true, ...cell.opts })` and
  `afterEach` calling `ctx.cleanup()`. Shared `commonArgs` fixture matching `quickstart.md §Scenario cookbook`.
  Also inject `describe('healthy path only', ...)` block for FRs whose assertions do not vary
  across revert cells (FR-006, FR-007, FR-010, FR-011). Every subsequent Phase 3 test body
  lands INSIDE this file. (plan §Approach 5, contracts/revert-scenarios.md)

- [ ] T009 [US1] Add FR-002 test bodies to `cockpit-gates-runid.integration.test.ts`:
  two `mcp.gateOpen` calls with same `(issueRef, gateType, generation)` and distinct `runId`
  values; ack the first to `applied` before opening the second. Assert both `gateId`s differ,
  peer received two distinct `cluster.cockpit` frames with those ids, and
  `fakeCloud.getByKey(..., runId=A)` and `.getByKey(..., runId=B)` return two docs. Under the
  Phase-B-reverted cell (opts.omitRunId), same test body but with `runId` omitted — assert the
  second gate open collides with the first (same `gateId`); name the test
  `FR-002 (Phase B reverted): re-run collides with terminal-state applied gate`.
  (plan §Approach 4 FR-002, quickstart §FR-002, contracts/revert-scenarios.md §Revert cell #2)

- [ ] T010 [US2] Add FR-003 test body: `gateOpen({ ..., runId: 'rid-x' })` → `waitFor` on
  `fakeCloud.getByKey(...)` returning non-null → `mcp.gateStatus({ ..., runId: 'rid-x' })`.
  Assert `.status === 'ok'`, `.data.status === 'open'`, `.data.gateId === openResult.data.gateId`.
  Also assert `mcp.gateList({ issueRef })` returns an entry with the same `gateId`. Under
  Phase-A-reverted cell, expect `data.status === 'absent'` (attribution: fake store dropped
  `generation`); name test accordingly. Under Phase-B-reverted cell, expect same failure via
  the FR-002 collision cascade. (plan §Approach 4 FR-003, quickstart §FR-003, contracts/revert-scenarios.md)

- [ ] T011 [US3] Add FR-004 test body: single `gateOpen({ ..., runId: 'rid-wakes' })`, then loop
  three "wakes" of `mcp.gateStatus(...)`. Assert every wake returns `data.status ∈ {open, answered}`
  (never `absent`). Assert the peer received exactly one `cluster.cockpit` frame filtered on
  `data.type === 'gate-open' && data.gateId === openId`. Assert
  `ctx.gateEmittedLogLines.filter((l) => l.gateId === openId).length === 1`. This is the pre-draft
  dedup invariant at the MCP boundary (Q2=C re-scoping — no subagent spawn count). Passes on all
  three revert cells (dedup is independent of runId). (plan §Approach 4 FR-004, quickstart §FR-004,
  research §Q4=C)

- [ ] T012 [US4] Add FR-005 test body: `gateOpen({ generation: 'P2', runId: 'rid-1' })` and
  `gateOpen({ generation: 'artifact-review:spec-review:abc123', runId: 'rid-2' })` (colon-bearing
  generation). Then `mcp.gateList({ issueRef })`. Assert each returned entry's `.generation`
  equals the input string byte-for-byte, no `:<runId>` suffix, no re-parsing artifacts. Under
  Phase-A-reverted cell, expect `.generation === '<pre-phase-a>'` sentinel on both entries;
  name test `FR-005 (Phase A reverted): generation renders as fallback`.
  (plan §Approach 4 FR-005, contracts/fake-cloud-store.md §Note on `generation`, contracts/revert-scenarios.md)

- [ ] T013 [US5] Add FR-006 test body (healthy-path-only block — no revert-cell variants):
  `gateOpen(...)`, capture the route-returned `frameId`, capture the corresponding
  peer-received `data.frameId`, assert byte-equal. Also assert `ctx.peer.payloadViolations.length === 0`
  (defence-in-depth from T005's payload validator). This is the load-bearing test that would have
  caught the `frameId`-shipped-inert bug. (plan §Approach 4 FR-006, spec §US5, contracts/fake-peer-payload-schema.md)

- [ ] T014 [US6] Add FR-007 test body: run a full `gateOpen → gateAck({ outcome: 'applied' })`
  cycle. Assert the `CountingLogger.records` contain zero entries whose `msg.includes('Invalid relay message, skipping')`.
  Also assert the fake-peer stdout / captured log does not emit the same string (it uses
  a different phrase today — `dropping frame that failed …` — so a genuine post-#1063 regression
  guard). (plan §Approach 4 FR-007, spec §US6, data-model §E6)

- [ ] T015 [US7] Add FR-008 test body: `gateOpen({ ...commonArgs })` WITHOUT `runId` field
  (not `runId: undefined`, actual omission). Assert `.status === 'ok'`, then
  `gateAck({ gateId, outcome: 'applied' })`. Assert
  `fakeCloud.getByKey(issueRef, gateType, generation, undefined)?.status === 'applied'`. This is
  the "cluster without Phase B" backward-compat path; the input schema already declares
  `runId: z.string().min(1).optional()` so no simulation flag is needed (Q3=C rationale,
  FR-012 constraint). (plan §Approach 4 FR-008, quickstart §FR-008)

- [ ] T016 [US7] Add FR-009 test body: `ctx.fakeCloud!.putRaw({ ...gateDocWithNoGeneration })` —
  hand-crafted pre-Phase-A doc with `generation: undefined` and a `gateKey` shape
  `owner/repo#N:phase-queue` (no generation segment). Then `mcp.gateList({ issueRef })`.
  Assert the doc surfaces via the pre-Phase-A fallback, with `.generation === '<pre-phase-a>'`
  sentinel per contracts/fake-cloud-store.md's decision. Verifies the list-mode fallback code
  path. (plan §Approach 4 FR-009, quickstart §FR-009)

- [ ] T017 [P] Create `packages/orchestrator/src/__tests__/cockpit-gates/no-simulate-phase-in-src.test.ts` —
  new file with a single `it('FR-012: no SIMULATE_PHASE_* switches in shipped code paths', ...)`
  that runs
  `grep -rE 'SIMULATE_PHASE_[A-Z]+' packages/{orchestrator,control-plane,cluster-relay}/src packages/generacy/src/cli/commands/cockpit packages/cockpit/src --exclude-dir={__tests__,tests} --exclude=*.{test,spec}.ts || true`
  and asserts the output is empty. Runs in the same suite as the FR tests so a rogue phase-simulation
  env var introduced in the same PR trips the guard immediately.
  (plan §Approach 4 FR-012, research §D-7, contracts/production-code-boundary.md)

## Phase 4: Regression + verification

<!-- Phase boundary: Phase 3 tests must be green before Phase 4. -->

- [ ] T018 Regression check: re-run the two sibling harnesses and confirm the T005 extension
  did not regress them —
  `pnpm --filter @generacy-ai/orchestrator test cockpit-gates-integration.integration.test.ts`
  and `pnpm --filter @generacy-ai/orchestrator test cockpit-gates-frameid.integration.test.ts`.
  Both must still pass. Every fixture body those files emit comes from
  `gateOpenFixture` / `gateOutcomeFixture` (schema-compliant by construction), so
  `payloadViolations` should stay empty across their runs. (contracts/fake-peer-payload-schema.md §Backwards compatibility)

- [ ] T019 Runtime budget check: `time pnpm --filter @generacy-ai/orchestrator test cockpit-gates-runid.integration.test.ts`.
  Assert local runtime under 90 s (SC-006 median budget). Sibling `.integration.test.ts` files
  run 15–25 s; expected 30–60 s. If over budget, first check for missing `ctx.cleanup()` in
  `afterEach` or a raised `relayReconnectMs`. Do NOT bypass by raising the budget — sibling
  timing is the lower-bound reference.

- [ ] T020 Verify no non-test files touched during implementation:
  `git diff --name-only develop.. -- 'packages/*/src/**' | grep -v -E '(\.test\.ts|\.spec\.ts|__tests__/)'`.
  Expected empty output → the CLAUDE.md test-only exemption applies and NO `.changeset/*.md`
  is required. If NON-empty (e.g. T003's D-3-c fallback introduced a re-export in
  `packages/cockpit/src/gates/`), add `.changeset/1068-*.md` with `@generacy-ai/cockpit` bumped
  `patch` (new internal re-export, no new capability). (plan §Constitution Check, §"Files touched")

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 (setup) → Phase 2 (helpers) → Phase 3 (FR tests) → Phase 4 (regression/verification).

**Within Phase 1** — T001 first (baseline must be green). T002 and T003 can run in either
order but both must complete before Phase 2 (their decisions gate T005 and T006).

**Within Phase 2** — T004 and T006 can run in parallel (different files, no dependencies).
T005 depends on T003 (schema import decision). T007 depends on T004, T005, T006 (wires all
three together).

**Within Phase 3** — T008 first (creates the test file scaffolding). T009–T016 all sit inside
the file created by T008 and can proceed in any order (each is its own `it()` block; Vitest
isolation provides FR-010's per-item attribution). T017 is a separate file and runs
in parallel with T008–T016.

**Within Phase 4** — T018–T020 are independent verification steps, can run in parallel.

## Parallel opportunities

- **T004 || T006**: both new files, no shared dependencies.
- **T008…T016**: same file, same author sequentially — but each `it()` block is independent
  and any subset can be dropped into the file in one commit if convenient.
- **T017**: independent file; can land alongside any Phase 3 task.
- **T018 || T019 || T020**: independent verifications.
