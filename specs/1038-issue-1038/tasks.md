# Tasks: Cockpit gates — read-only status query + stable sweep generation derivation

**Input**: Design documents from `/specs/1038-issue-1038/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ (cockpit_gate_status.md, cockpit_gate_list.md, gate-query.md, gate-query.schema.json, generation-derivation.md), quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = sweep skips already-open gates; US2 = gateIds coalesce)

## Phase 1: Setup

- [ ] T001 Add `.changeset/1038-cockpit-gates-query.md` at repo root — `@generacy-ai/cockpit` **minor** (new `computeClarificationAnswerSetHash` public export), `@generacy-ai/generacy` **minor** (new MCP tools + new `ErrorClass` member `query-unreachable`), `@generacy-ai/orchestrator` **patch** (internal route + client, no public API change). Body per quickstart.md § Changeset. CI gate will fail without this file.

- [ ] T002 [P] Add `'query-unreachable'` to the `ErrorClass` union in `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`. Slot it between `'transport'` and `'invalid-cursor'` per data-model.md § ErrorClass extension. Add a short header comment explaining the divergence from `'transport'` per plan.md D-2 (read-fail vs write-fail; distinct downstream dispatch).

## Phase 2: `@generacy-ai/cockpit` — pure `generation` helpers (US2)

<!-- Depends on: none. Blocks: parity tests in Phase 6 that assert sweep/live parity via SC-002 fixtures. -->

- [ ] T010 [US2] Create `packages/cockpit/src/gates/clarification-hash.ts` exporting `ClarificationQuestion`, `ComputeClarificationAnswerSetHashInput`, and `computeClarificationAnswerSetHash({ questions })`. Algorithm per data-model.md § computeClarificationAnswerSetHash and research.md R7: sort ascending by `questionNumber`, project to `{ questionNumber, questionText }` only (strip other fields), `JSON.stringify` → `sha256` (via `node:crypto`) → first 12 hex. Pure function, zero I/O.

- [ ] T011 [P] [US2] Re-export `computeClarificationAnswerSetHash` and `ClarificationQuestion` from `packages/cockpit/src/gates/index.ts`, then re-export from the package root `packages/cockpit/src/index.ts` so callers can `import { computeClarificationAnswerSetHash } from '@generacy-ai/cockpit'` (per quickstart.md § Usage). Do NOT change `deriveClarificationGeneration`'s signature.

- [ ] T012 [P] [US2] Add cross-reference comment above `deriveClarificationGeneration` in `packages/cockpit/src/gates/generation.ts` pointing to `clarification-hash.ts` for the canonical `batchId` construction path. No behavior change. Documents plan D-3 additive-not-breaking choice.

- [ ] T013 [P] [US2] Extend `packages/cockpit/src/gates/fixtures.ts` with `CLARIFICATION_ANSWER_SET_FIXTURES` frozen map per data-model.md § Fixtures: `singleQuestion`, `threeQuestions` (deliberately out-of-order input to prove sort determinism), plus a `unicode` entry (non-ASCII `questionText` bytes) for canonicalization coverage.

- [ ] T014 [US2] Add `packages/cockpit/src/gates/__tests__/clarification-hash.test.ts` covering: (a) sort-stability (out-of-order input matches sorted input); (b) projection strip (extra fields on input questions do NOT alter the hash); (c) determinism (same input → byte-identical output across N calls); (d) `.length === 12`; (e) unicode round-trip. Uses fixtures from T013.

- [ ] T015 [US2] Add `packages/cockpit/src/gates/__tests__/generation-parity.test.ts` proving SC-002 for `clarification` and `implementation-review`: for each fixture, construct "sweep-derived" and "live-derived" inputs from the same GitHub-state projection, run `computeClarificationAnswerSetHash` → `deriveClarificationGeneration` → `deriveGateKey` → `deriveGateId` (or `deriveImplementationReviewGeneration` for the review path), assert both call chains produce byte-identical `gateId`. Add defensive-coverage entries for `artifact-review` (per gate-kind × head SHA) and `manual-validation` per contracts/generation-derivation.md.

## Phase 3: Orchestrator — cloud query client + `GET /cockpit/gates` route (US1)

<!-- Depends on: T002 (ErrorClass — needed only if this file imports it, but keep the phase boundary loose). Blocks: MCP-tool tests in Phase 6. -->

- [ ] T020 [P] [US1] Create `packages/orchestrator/src/services/cloud-gate-query-client.ts` implementing the `CloudGateQueryClient` interface per data-model.md § Cluster → cloud query client. Two methods: `getGateStatus({ issueRef, gateType, generation })` and `listGates({ issueRef, gateType? })`. Uses `node:https.request` with `AbortController` (5000ms default), `Authorization: Bearer <cluster-api-key>` header (mtime-cached read from `/var/lib/generacy/cluster-api-key` — mirror the pattern in `packages/control-plane/src/services/cluster-api-key.ts`). Endpoint: `GET ${GENERACY_API_URL}/api/clusters/${clusterId}/cockpit/gates?...`. Throws `CloudTransportError` on network / DNS / timeout / 5xx; throws `CloudRequestError` on 4xx. **No client-side retry** (retry lives in the MCP tool per plan D-2 / research R2). Constructor accepts `httpsRequestImpl` seam for tests. Mirror shape of `packages/control-plane/src/services/cloud-pull-client.ts`.

- [ ] T021 [P] [US1] Add `packages/orchestrator/src/services/__tests__/cloud-gate-query-client.test.ts` covering: (a) request URL shape (query-string encoding of `issueRef`, optional `gateType`, optional `generation`); (b) `Authorization: Bearer` header present and matches injected key; (c) 200 JSON parses through to typed response for both status and list modes; (d) 502 / 503 / 504 → `CloudTransportError`; (e) 4xx → `CloudRequestError`; (f) 200-with-malformed-body → `CloudRequestError`; (g) `AbortController` fires after `timeoutMs`; (h) missing cluster API key file → error surfaces cleanly (not swallowed).

- [ ] T022 [US1] Extend `packages/orchestrator/src/routes/cockpit-gates.ts` with a `GET /cockpit/gates` handler (existing `POST` handlers untouched). Query-string validation via `GateQueryStringSchema` (data-model.md § Query-string schema): `.strict()` + `.refine(v => v.generation === undefined || v.gateType !== undefined)`. Dispatch rule per data-model.md § Orchestrator route: `generation` present → call `client.getGateStatus`; absent → call `client.listGates`. Apply the seven-to-three cloud-status collapse (contracts/gate-query.md § Cloud-status → MCP-facing collapse; also data-model.md table). Apply the non-terminal filter for list responses before the collapse. Response shapes: `{ gateId, status }` for status-mode (with `gateId: null` for `absent`); `{ gates, truncated? }` for list-mode. Non-2xx: 400 `invalid-query` on validation failure; 502 on `CloudTransportError`; 500 on `CloudRequestError` or unexpected. Log fields per contracts/gate-query.md § Observability (`issueRef`, `gateType`, `mode`, `cloudDurationMs`, `resultCount` or `mappedStatus`) — no PII, no gate body.

- [ ] T023 [US1] Extend `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` (existing) with GET-route branches: (a) status-mode 200 for cloud `open`/`answered`/`delivered`/`applied` → correct three-state collapse; (b) status-mode 200 for cloud `superseded`/`failed`/`expired`/no-match → `{ gateId: null, status: 'absent' }`; (c) list-mode 200 filters terminal cloud statuses and collapses `delivered → answered`; (d) list-mode with `gateType` filter narrows correctly; (e) 400 when `generation` present without `gateType`; (f) 400 on missing `issueRef`; (g) 502 when the injected `CloudGateQueryClient` throws `CloudTransportError`; (h) 500 on `CloudRequestError`; (i) no `POST` handler regressions (existing tests still pass unchanged).

- [ ] T024 [P] [US1] Wire the `CloudGateQueryClient` into orchestrator startup: add a `getCloudGateQueryClient` factory to the route options bag in `packages/orchestrator/src/routes/cockpit-gates.ts` (or the closest existing options-injection site — mirror how the existing POST route resolves its dependencies) so `clusterId` is read from `cluster.json` at boot exactly once and the route handler consumes the pre-constructed client. Wiring lives in the orchestrator's server bootstrap; keep the route handler pure (client-in, response-out).

## Phase 4: MCP-side query client + retry helper (US1)

<!-- Depends on: T002 (ErrorClass). Blocks: tool handlers (Phase 5) and parity tests (Phase 6). -->

- [ ] T030 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts` exporting the Zod schemas per data-model.md § Core types: `CockpitGateStatusInputSchema` (strict, `issueRef` min-1, `gateType` from closed 8-enum, `generation` string-or-number); `CockpitGateStatusDataSchema` (union of `{ gateId: 24-hex, status: 'open'|'answered' }` OR `{ gateId: null, status: 'absent' }`); `CockpitGateListInputSchema` (strict); `CockpitGateListEntrySchema`; `CockpitGateListDataSchema` (`{ gates: [...], truncated?: boolean }`). Export TypeScript types via `z.infer`.

- [ ] T031 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/gates/retry.ts` exporting `RetrySchedule`, `QUERY_RETRY_SCHEDULE` (Object.freeze `{ delays: [0, 1500, 3500] }` — 3 attempts, ≤5000ms budget per plan D-2 / research R2), `WithRetryOptions`, and `withRetry<T>()` async helper. Pure function of `(fn, schedule, shouldRetry, sleep?)`. `sleep` defaults to `setTimeout`-backed `Promise` — inject in tests for fake-timer determinism.

- [ ] T032 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts` — the **read-side** HTTP client. **MUST NOT import** `./client.ts` (write path), `../tools/cockpit_gate_open.ts`, `../tools/cockpit_gate_ack.ts`, or `../../../../../../orchestrator/src/routes/retained-cockpit-events.ts` (observer independence per FR-012 / research R12). Uses Node ≥22 built-in `fetch` (per research R3), reads base URL from `BuildMcpServerDeps.orchestratorUrl ?? process.env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100'` (per research R4). Two methods: `getGateStatus(input)` → `GET /cockpit/gates?...&generation=...`; `listGates(input)` → `GET /cockpit/gates?...` (no `generation`). Single-call contract (no retry — retry lives in tool handlers per T031). Maps HTTP outcomes to typed errors: 400 → `QueryInvalidArgsError`; 4xx → `QueryInternalError`; 5xx / network / timeout → `QueryTransportError`; 2xx-with-bad-JSON → `QueryInternalError`. AbortController for per-attempt timeout (5000ms default; overridable via `orchestratorTimeoutMs`).

- [ ] T033 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/query-client.test.ts` covering: (a) status-mode URL shape (query-string encoding); (b) list-mode URL shape; (c) 200 JSON deserialization for both modes; (d) 400 → `QueryInvalidArgsError`; (e) 5xx → `QueryTransportError`; (f) network error → `QueryTransportError`; (g) 2xx malformed body → `QueryInternalError`; (h) AbortController timeout fires; (i) does NOT retry (asserts fetchImpl invoked exactly once per call).

- [ ] T034 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/retry.test.ts` covering: (a) fires exactly `schedule.delays.length` attempts on persistent failure; (b) honors delays in order (with `sleep` seam / fake timers); (c) `shouldRetry === false` short-circuits regardless of remaining attempts; (d) success on attempt N short-circuits; (e) `QUERY_RETRY_SCHEDULE` total = 5000ms exactly; (f) frozen — mutation attempts throw.

## Phase 5: MCP tools + registration (US1)

<!-- Depends on: T030, T031, T032. Blocks: parity tests (Phase 6). -->

- [ ] T040 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.ts` — MCP tool handler. Thin wrapper: parse input via `CockpitGateStatusInputSchema` (parse failures → `{ status: 'error', class: 'invalid-args', ... }`); call `withRetry({ fn: () => queryClient.getGateStatus(input), schedule: QUERY_RETRY_SCHEDULE, shouldRetry: isRetryableGateQueryError })`; on exhausted retry → `{ status: 'error', class: 'query-unreachable', detail: <last-error>, hint: 'query gate status after connectivity is restored' }`; on `QueryInvalidArgsError` → `'invalid-args'`; on `QueryInternalError` → `'internal'`; on success → `{ status: 'ok', data: { gateId, status } }`. `shouldRetry` predicate: true for `QueryTransportError`; false for `QueryInvalidArgsError` / `QueryInternalError` / success. **MUST NOT import** any write-path modules (FR-012).

- [ ] T041 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts` — same shape as T040 but calls `queryClient.listGates` and returns `{ status: 'ok', data: { gates, truncated? } }` on success. Same error-class mapping. Same observer-independence constraints.

- [ ] T042 [US1] Extend `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` to re-export `CockpitGateStatusInputSchema` and `CockpitGateListInputSchema` from `./gates/query-schemas.js`. Match the existing `schemas.ts` re-export style (used by tool-schema-audit).

- [ ] T043 [US1] Register both tools in `packages/generacy/src/cli/commands/cockpit/mcp/server.ts` alongside the existing gate-open / gate-ack registrations (near `:205` / `:216`). Add a header comment above the two new registrations documenting: (i) observer independence — these are read-only and MUST NOT touch write-path modules; (ii) the plan.md § Constitution "invariant #1 exception" that these tools have no CLI-verb counterpart because they only make sense inside an active `/cockpit:auto` sweep step (matches the existing #1022 header comment).

## Phase 6: MCP-boundary tests + observer independence (US1)

<!-- Depends on: T040, T041, T042, T043. -->

- [ ] T050 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-status.test.ts` (MCP-boundary tests, in-process transport, `fetchImpl` seam — mirror `parity-gate-open.test.ts` / `parity-gate-ack.test.ts` shape). Cover: (a) happy path `open`, `answered`, `absent` each round-trip through the tool boundary; (b) retry exhaustion → `class: 'query-unreachable'`; (c) transient 502 succeeds on retry attempt 2; (d) 400 → `class: 'invalid-args'`; (e) 200-with-malformed-body → `class: 'internal'`; (f) `absent` vs error distinction — `{ status: 'ok', data: { gateId: null, status: 'absent' } }` must NOT be confusable with the error envelope (FR-013); (g) input `.strict()` catches `issue_ref` / `gate_type` typos.

- [ ] T051 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts` covering: (a) empty list `{ gates: [] }` → success (not error); (b) single-entry list; (c) many-entry list; (d) `gateType` filter narrows list; (e) `truncated: true` passes through when present; (f) `truncated` absent (not `false`) when list is complete; (g) retry exhaustion → `query-unreachable`; (h) input `.strict()` typo rejection.

- [ ] T052 [US1] Extend `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/observer-independence.test.ts` (existing static import-scan from #1015). Add assertions that `tools/cockpit_gate_status.ts` and `tools/cockpit_gate_list.ts` do NOT import: (i) `./gates/client.ts` or `./gates/client.js`; (ii) `../tools/cockpit_gate_open`; (iii) `../tools/cockpit_gate_ack`; (iv) anything with `retained-cockpit-events` in the path; (v) anything with `retain` in the path (defensive per research R12 rule #4). Regex-based text scan; failure message names the forbidden import for each file (SC-005).

- [ ] T053 [US1] Extend `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-audit.test.ts` (existing): assert `cockpit_gate_status` and `cockpit_gate_list` appear in the registered tool list; assert their input schemas reject `{}` (missing required fields); assert their input schemas accept the canonical fixtures from `packages/cockpit/src/gates/fixtures.ts` and quickstart.md § Usage.

## Phase 7: Cross-repo contract mirror (FR-010)

<!-- Depends on: nothing code-side; pure doc copy. Can run any time. -->

- [ ] T060 [P] [US1] Copy `specs/1038-issue-1038/contracts/gate-query.md` to `specs/1020-part-cockpit-remote-gates/contracts/gate-query.md` (byte-identical) and `specs/1038-issue-1038/contracts/gate-query.schema.json` to `specs/1020-part-cockpit-remote-gates/contracts/gate-query.schema.json` (byte-identical). Per FR-010 and research R14, generacy-cloud reads the `1020-*` mirror; drift between the two copies is a spec violation. Do NOT edit either copy in isolation.

## Phase 8: Verification

<!-- Depends on: all prior phases. Runs before PR opens. -->

- [ ] T070 [US1][US2] Run `pnpm --filter @generacy-ai/cockpit build test`, `pnpm --filter @generacy-ai/generacy build test`, and `pnpm --filter @generacy-ai/orchestrator build test`. All must pass. If any observer-independence assertion fails, the fix is to remove the offending import, NOT to weaken the assertion (the assertion is a drift audit — weakening deletes its value).

- [ ] T071 [US1] Verify the CLAUDE.md changeset gate: `pnpm changeset status` (reads working directory) shows `1038-cockpit-gates-query.md` recognized and lists the three package bumps (`@generacy-ai/cockpit` minor, `@generacy-ai/generacy` minor, `@generacy-ai/orchestrator` patch). If any src/ touch is missing from the changeset packages, add it — the gate only checks that *some* changeset is added, so a missing package silently ships unreleased (per CLAUDE.md § Changesets).

- [ ] T072 [US1] Sanity-check the JSON Schema mirror: `contracts/gate-query.schema.json` in this feature and `specs/1020-part-cockpit-remote-gates/contracts/gate-query.schema.json` produce a byte-identical `diff`. Any drift blocks PR merge.

- [ ] T073 [US1] Manual smoke: follow quickstart.md § "Running the two tools locally" against a mock orchestrator — invoke `cockpit_gate_status` with a fixture input, confirm the response envelope shape matches `contracts/cockpit_gate_status.md`. Repeat for `cockpit_gate_list`. Confirms end-to-end wiring from MCP tool → HTTP client → orchestrator route → cloud query client (mocked). If a live cloud endpoint is not yet available in staging, this reduces to injecting a mocked `fetchImpl` per the same seam the parity tests use.

## Dependencies & Execution Order

**Sequential phase boundaries** (each phase completes before the next starts):

- Phase 1 (Setup — T001, T002) → unblocks everything downstream by adding the `ErrorClass` member and changeset envelope.
- Phase 2 (Cockpit helpers — T010-T015) can run **fully in parallel with Phase 3 and Phase 4**; they share no files. Blocks only Phase 6's parity assertions (via SC-002).
- Phase 3 (Orchestrator route + cloud client — T020-T024) blocks Phase 4's live-fetch parity tests (T033 exercises the client contract, but does not require the orchestrator to be running).
- Phase 4 (MCP query client + retry — T030-T034) blocks Phase 5.
- Phase 5 (Tool handlers + registration — T040-T043) blocks Phase 6.
- Phase 6 (MCP-boundary + observer tests — T050-T053) is the last code phase.
- Phase 7 (Contract mirror — T060) is independent; can run any time after Phase 3 exists.
- Phase 8 (Verification — T070-T073) runs after everything above.

**Parallel opportunities within phases**:

- Phase 1: T001 and T002 are independent files → both `[P]` candidates (T002 marked `[P]`; T001 is a solo changeset file so mark unset).
- Phase 2: T011, T012, T013 all touch different files → parallel. T014 depends on T010; T015 depends on T010 + T013.
- Phase 3: T020 and T021 are independent (client + client test) → parallel. T022 depends on T020 (imports the client type). T023 depends on T022. T024 depends on T020 + T022 (wiring both).
- Phase 4: T030, T031 are independent → parallel. T032 depends on T030 (input types). T033 depends on T032; T034 depends on T031.
- Phase 5: T040 depends on T030+T031+T032. T041 same dependencies → parallel with T040. T042 and T043 depend on T040+T041.
- Phase 6: T050 and T051 are independent → parallel. T052 and T053 depend on T043 (registered tool list). T052 and T053 can run in parallel with each other.

**Critical path**: T001 → T002 → T032 → T040 → T043 → T050 → T070.

**Story slices**:

- **US2 (gateIds coalesce)** is fully deliverable end-to-end after Phase 2 completes (T010-T015). No dependency on the query tools or orchestrator route. Parity test T015 is the acceptance signal for SC-002.
- **US1 (sweep skips already-open gates)** requires Phases 3 + 4 + 5 + 6 together. Parity tests T050/T051 are the acceptance signal for SC-001/SC-003/SC-004/SC-007.

## Notes

- **No `packages/claude-plugin-cockpit/commands/*.md` playbook edits** in this repo — the `claude-plugin-cockpit` package lives in generacy-ai/agency, not here. Any `auto.md` references in spec.md / plan.md are to the agency-side file (out of scope; consumed by generacy-ai/agency#450). No playbook-verification re-pin task is needed.
- The spec explicitly rules out cloud-side Firestore query implementation (owned by generacy-cloud companion PR under epic 850). The orchestrator route is a pass-through; T022's tests use an injected `CloudGateQueryClient` and never require a live cloud endpoint.
- The `deriveClarificationGeneration` helper signature is intentionally unchanged (plan D-3). Existing tests and fixtures that pass a literal `batchId` continue to work; new callers use the hash helper as the `batchId` source.
