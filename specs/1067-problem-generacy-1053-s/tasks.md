# Tasks: `runId` on gate-query MCP tools (Phase B of #1053 fix)

**Input**: Design documents from `/specs/1067-problem-generacy-1053-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/{query-schemas,cloud-url,changeset}.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Foundational Types (leaves — no cross-file dependencies)

- [ ] T001 [P] [US2] Widen `GetGateStatusInput` in `packages/orchestrator/src/services/cloud-gate-query-client.ts` by adding optional `runId?: string` to the interface (data-model E3). Update `getGateStatus()` to include `runId: input.runId` in the query object passed to `buildUrl`. **Do not** modify `buildUrl` — the existing `if (v !== undefined)` skip preserves byte-compat (plan R1). **Do not** widen `ListGatesInput` or `listGates` (Q1=C).

- [ ] T002 [P] [US1, US2] Widen `CockpitGateStatusInputSchema` AND `CockpitGateListInputSchema` in `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts` by adding `runId: z.string().min(1).optional()` to each. Both schemas MUST remain `.strict()` and remain flat `z.object({...}).strict()` (no `z.intersection`, no `z.and`) — FR-001, FR-002, SC-006. Include the JSDoc comments from data-model E1/E2 explaining the intent and the list-side drop.

## Phase 2: Wiring (depends on Phase 1)

- [ ] T003 [US2] Widen `GateQueryStringSchema` in `packages/orchestrator/src/routes/cockpit-gates.ts` (line 57-66 area) by adding `runId: z.string().min(1).optional()` as a passive pass-through. **Do not** add a duplicate `.refine((v) => v.runId === undefined || v.generation !== undefined, ...)` — the cloud route enforces that authoritatively; duplicating would mask the cloud's RFC-7807 400 (data-model E4, research R5). In the status branch (`generation !== undefined`), forward `runId` to `client.getGateStatus({...})`. In the list branch, do **not** forward `runId` to `client.listGates(...)`. Include the JSDoc comment from data-model E4.

- [ ] T004 [US2] Extend `buildStatusUrl` in `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts` to conditionally set `url.searchParams.set('runId', input.runId)` when `input.runId !== undefined`. Parameter key MUST be exactly `'runId'` (camelCase — pinned by deployed cloud contract per Q2). Leave `buildListUrl` unchanged.

- [ ] T005 [US2, US5] Thread `runId` through the tool handler in `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.ts`:
    1. Pass `parsed.data.runId` into the `queryInput` for the cloud call.
    2. Compute `const runIdSource = parsed.data.runId !== undefined ? 'explicit' : 'unset'`.
    3. Emit a **post-call** structured log on BOTH success AND failure paths with field shape `{ event: 'cockpit_gate_status.runid-source', runIdSource, mode: 'status', gateType, issueRef, resolvedStatus, gateId }`. On the failure path, add `error` field with the error surfaced. Reference: `cockpit_gate_open.ts:80-97` for the pattern.
    4. The `runId` **value** MUST NEVER appear in the emitted log record — only the `runIdSource` label. This is data-model E5 and FR-008.

- [ ] T006 [US1, US2] Modify `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts` so that `parsed.data.runId` is READ (schema now accepts it) but NOT PASSED to `client.listGates(...)`. Add an inline comment at the drop site naming the cloud refine (`.refine((q) => q.runId === undefined || q.generation !== undefined, { message: 'runId requires generation' })`) as the reason. **Do not** emit the `runIdSource` log line here (Q3=C).

## Phase 3: Tests

- [ ] T007 [P] [US1, US2] Create `packages/orchestrator/src/services/__tests__/cloud-gate-query-client.runid.test.ts` covering:
    - **SC-001a** (snapshot): assert the exact canonical URL from `contracts/cloud-url.md` § "runId OMITTED" — `https://api.generacy.ai/api/clusters/cluster-abc-123/cockpit/gates?issueRef=generacy-ai%2Fgeneracy%2342&gateType=implementation-review&generation=abc123` — equals the URL produced by `getGateStatus` with `runId === undefined`.
    - **SC-001b** (structural): assert `searchParams.keys()` returns exactly `['issueRef', 'gateType', 'generation']` and `searchParams.has('runId') === false`.
    - **SC-003a** (status with runId): with `runId: 'auto-cluster-1067-1722243247891'` supplied, assert the outbound URL matches the canonical URL from `contracts/cloud-url.md` § "runId SUPPLIED" and `searchParams.get('runId') === 'auto-cluster-1067-1722243247891'`.
    - **SC-003b** (list never carries runId): assert that `listGates` never produces a URL containing `runId=...` even if callers accidentally attempt to pass one (spike a defensive test via the type-cast escape hatch).

- [ ] T008 [P] [US1, US5] Extend `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-status.test.ts`:
    - Keep the existing SC-006 assertion (inputSchema flat `z.object` with non-empty `properties`).
    - **Add** widened-shape acceptance: `.safeParse({issueRef, gateType, generation, runId})` returns `success: true`.
    - **Add** legacy byte-compat: `.safeParse({issueRef, gateType, generation})` returns `success: true` and the parsed `data` shape has NO `runId` property (SC-002).
    - **Add** typo-guard: `.safeParse({..., run_id: 'oops'})` returns `success: false` with `unrecognized_keys` (`.strict()` boundary preserved).

- [ ] T009 [P] [US1, US5] Extend `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts` with the same three additions as T008, adapted to the list input shape (`{issueRef, gateType?, runId?}`).

- [ ] T010 [P] [US4] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-tuple-identity.test.ts` — FR-006 / SC-005 three-tool identity matrix. Use a fake cloud (in-memory `Map<gateKeyPreImage, gateId>`) keyed by 4-tuple pre-image, matching the pattern in existing `mcp/__tests__/*.integration.test.ts`. For each combination of `(issueRef, gateType, generation, runId?)` in this matrix — at minimum:
    - 3-tuple case (no `runId`)
    - 4-tuple case (explicit `runId`)
    - Distinct `runId` values (`'A'` vs `'B'`) produce different `gateId`s
    - Empty-`generation` boundary
    
    assert that:
    - `deriveGateKey` / `deriveGateId` from the write path (`cockpit_gate_open`) produces the same `gateKey`/`gateId` as
    - The tuple carried on the `cockpit_gate_status` outbound URL, as
    - The `gateId` returned by the fake cloud in `cockpit_gate_list` entries.

- [ ] T011 [P] [US2] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit-gate-status-runid.test.ts` — FR-008 log-line assertion. Assert:
    - **Success path**: after a successful `cockpit_gate_status` call with `runId` present, exactly one log record with `event: 'cockpit_gate_status.runid-source'`, `runIdSource: 'explicit'`, `mode: 'status'`, and the correct `gateType`, `issueRef`, `resolvedStatus`, `gateId` is emitted.
    - **Success path, no runId**: same call without `runId` produces the record with `runIdSource: 'unset'`.
    - **Failure path**: on transport error / cloud 4xx/5xx, the same record is emitted with `resolvedStatus: 'error'`, `gateId: null`, and an `error` field carrying the surfaced error.
    - **`runId` value NEVER logged**: assert the emitted record does NOT contain a `runId` field (only `runIdSource`). Data-model E5 invariant.
    - **`cockpit_gate_list` MUST NOT emit this record**: cover with a negative assertion.

- [ ] T012 [P] [US2, US3] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/gate-open-then-status-runid.integration.test.ts` — SC-004 end-to-end with fake cloud persisting by 4-tuple pre-image (research R6):
    1. `cockpit_gate_open({triple, runId: 'A'})` → cloud stores 4-tuple.
    2. `cockpit_gate_status({triple, runId: 'A'})` → returns `'open'` (not `'absent'`).
    3. `cockpit_gate_open({triple, runId: 'B'})` → cloud stores a DIFFERENT 4-tuple.
    4. `cockpit_gate_status({triple, runId: 'A'})` → still returns `'open'` (isolated by `runId`).
    5. `cockpit_gate_status({triple, runId: 'B'})` → returns `'open'` (fresh gate — US3).
    6. `cockpit_gate_status({triple})` (no `runId`) → does not throw, returns a defined `ThreeState` (byte-compat; legacy path behaviour is cloud-owned).

## Phase 4: Verification

- [ ] T013 [US1] Add `.changeset/1067-runid-on-gate-query.md` matching the exact shape in `contracts/changeset.md`: `@generacy-ai/generacy` **patch** and `@generacy-ai/orchestrator` **patch**. This MUST be a newly added file in the PR diff (the CI gate greps `--diff-filter=A`); editing an existing changeset does not satisfy the gate.

- [ ] T014 [US1, US2] Run `pnpm typecheck` at repo root; expect zero errors (SC-008). Every existing call site of `getGateStatus` / `listGates` must compile with the widened input type (`runId?` is optional).

- [ ] T015 [US1, US2, US3, US4, US5] Run the test batches from `quickstart.md § Running the tests`. All of the following must pass:
    - `packages/generacy` test filter over: `parity-gate-status.test.ts`, `parity-gate-list.test.ts`, `parity-gate-tuple-identity.test.ts`, `cockpit-gate-status-runid.test.ts`, `gate-open-then-status-runid.integration.test.ts`, `observer-independence.test.ts` (SC-007 unchanged).
    - `packages/orchestrator` test filter over: `cloud-gate-query-client.runid.test.ts`, `routes/__tests__/cockpit-gates.test.ts`.

## Dependencies & Execution Order

**Phase 1 → Phase 2 → Phase 3 → Phase 4.**

- **T001 and T002 are true leaves** (marked `[P]`): different packages, no cross-file deps. Run in parallel.
- **T003 depends on T001** (route imports `getGateStatus` widened input type from the client).
- **T004, T005, T006 depend on T002** (they consume the widened MCP schemas). T004 has no consumer within Phase 2, but T005 and T006 read `parsed.data.runId` produced by T002's schema.
- **T007 depends on T001** (tests the orchestrator client URL construction).
- **T008–T012 depend on T002–T006** (test the widened MCP schemas and tool handlers end-to-end).
- **T007–T012 are all `[P]`**: each writes to a distinct new or existing test file with no cross-dependencies.
- **T013 is independent** of tests (changeset file); can land alongside Phase 1 or later.
- **T014 depends on T001–T006** (typecheck reads the widened types).
- **T015 depends on T001–T012** (runs the tests written in Phase 3).

**Parallel opportunities**:
- Phase 1: `T001, T002` in parallel.
- Phase 3: `T007, T008, T009, T010, T011, T012` all in parallel.

**Landing-check reminder** (from `quickstart.md § Landing check`): before merging, on-call MUST verify that cloud Phase A (`generacy-cloud#892`, merge `192fca7c`) is deployed to prod. Landing this PR before Phase A produces the silent write-4/read-3 mismatch that is the exact #1059 root cause.

---

*Generated by /speckit:tasks on 2026-07-29.*
