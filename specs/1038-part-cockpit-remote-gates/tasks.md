# Tasks: Cockpit gates — read-only gate-status query + stable clarification generation

**Input**: Design documents from `/specs/1038-part-cockpit-remote-gates/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/ (cockpit_gate_status.md, cockpit_gate_list.md, get-cockpit-gates.md, gate-query-relay-envelope.md)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = sweep skip, US2 = restart-safe identity, US3 = operator list)
- **INV/FR/R/SC anchors**: reference plan.md § Design invariants, spec.md § Functional Requirements, research.md, and success criteria for reviewer traceability.

## Phase 1: Shared wire contract (`@generacy-ai/cockpit`)

Establishes the byte-identical hash both the sweep path and the live path will call — MUST land first because Phase 4's MCP tools and the SC-002 parity fixture both depend on the new `deriveClarificationGeneration` shape.

- [X] T001 [US2] Rewrite `deriveClarificationGeneration` in `packages/cockpit/src/gates/generation.ts` per data-model.md §4:
  - Replace `ClarificationGenerationInput` from `{ batchId: string }` to `{ questions: ClarificationBatchQuestion[] }` where `ClarificationBatchQuestion = { questionNumber: number; questionText: string }`.
  - Export new `ClarificationBatchQuestion` interface.
  - Implementation: `[...input.questions].sort((a,b) => a.questionNumber - b.questionNumber).map(q => ({ questionNumber: q.questionNumber, questionText: q.questionText }))` → `JSON.stringify` → `createHash('sha256').update(bytes,'utf8').digest('hex').slice(0,24)`.
  - Import `createHash` from `node:crypto`.
  - Preserve every other export in this file byte-for-byte (do NOT modify `deriveImplementationReviewGeneration`, `deriveArtifactReviewGeneration`, etc. — R6 says `implementation-review` is already correct).

- [X] T002 [US2] Update re-exports in `packages/cockpit/src/gates/index.ts`:
  - Add `type ClarificationBatchQuestion` to the `generation.js` re-export block.
  - Confirm `ClarificationGenerationInput` type re-export still resolves (name unchanged; shape changed).

- [X] T003 [US2] Extend `packages/cockpit/src/gates/__tests__/gates-generation.test.ts` with the **SC-002 parity fixture**:
  - Given `{questions: [{questionNumber:2, questionText:'What is the retry budget?'}, {questionNumber:1, questionText:'Which transport should we use?'}]}`, compute the canonical bytes shown in data-model.md §4 "Sample hash".
  - Commit the exact 24-char sha256 prefix inline as a reference constant. Any drift in the canonicalization contract breaks this test (INV-1, SC-002).
  - Additional case: two calls with the same set of questions but different insertion order produce IDENTICAL bytes (proves the sort step).
  - Additional case: `deriveGateId(deriveGateKey(issueRef, 'clarification', deriveClarificationGeneration({questions})))` is byte-identical when the input questions match — the load-bearing sweep-vs-live equality (SC-002).
  - Additional case: `deriveGateId(deriveGateKey(issueRef, 'implementation-review', deriveImplementationReviewGeneration({headSha:'abc123'})))` — same-input equality parity for the second sweep-critical gate type.
  - Whitespace preservation: `{questions:[{questionNumber:1, questionText:'  trimmed  '}]}` vs `{...text:'trimmed'}` produce DIFFERENT hashes (proves the "no trim" contract in data-model.md §4).

## Phase 2: Relay envelope pair (`@generacy-ai/cluster-relay`)

Adds the wire types the orchestrator service will send. Parallelizable with Phase 1 — different package, no shared imports.

- [X] T010 [P] [US1] Add `GateQueryRequestMessage` + `GateQueryResponseMessage` interfaces and Zod schemas in `packages/cluster-relay/src/messages.ts` per contracts/gate-query-relay-envelope.md:
  - Import `GateType` / `GateTypeSchema` from `@generacy-ai/cockpit`.
  - Add both TS interfaces exactly matching the contract's `## gate_query_request` and `## gate_query_response` sections.
  - Add `GateQueryRequestMessageSchema` and `GateQueryResponseMessageSchema` — the latter uses `z.union([SinglePayload, ListPayload])` for the optional `payload` field.
  - Append both variants to the `RelayMessage` union AND the `RelayMessageSchema` discriminated union.
  - Do NOT enforce cross-field rules in Zod (per data-model.md §5) — construction-site rules only, cloud responder validates.

- [X] T011 [P] [US1] Re-export the two new interfaces and both schemas from `packages/cluster-relay/src/index.ts` (or the current package entry) so `import { GateQueryRequestMessage } from '@generacy-ai/cluster-relay'` type-narrows without reaching into `messages.js`.

- [X] T012 [P] [US1] Extend `packages/cluster-relay/src/__tests__/messages.test.ts` (or the equivalent parse-round-trip test file) per contracts/gate-query-relay-envelope.md § Test coverage:
  - Round-trip: `parseRelayMessage()` accepts a well-formed `gate_query_request`.
  - Round-trip: well-formed `gate_query_response` for **both** single AND list payload shapes.
  - Malformed: `gate_query_response` with `status:'ok'` but no `payload` → `parseRelayMessage` returns null.
  - Malformed: `gate_query_response` with `payload.gateId` of wrong length → null.
  - Discriminated union: unknown `type: 'gate_query_unknown'` → null.

## Phase 3: Orchestrator service + HTTP route

Depends on Phase 2 (imports the new envelope types).

- [X] T020 [US1] Create `packages/orchestrator/src/services/gate-status-query.ts` per contracts/get-cockpit-gates.md § Service contract:
  - Export `QuerySingleInput`, `QuerySingleResult`, `QueryListInput`, `QueryListResult` interfaces (shapes per contract).
  - Export `QueryUnreachableError` class carrying `attempts`, `lastReason`, and a human-readable `message`.
  - Export `MalformedCloudResponseError` class carrying `issues` (Zod issue list).
  - Export `GateStatusQueryService` class with:
    - Constructor deps: `{ getRelayClient: () => ClusterRelayClient | null; logger: Logger; generateCorrelationId?: () => string; perAttemptTimeoutMs?: number }`.
    - `querySingle(input)` and `queryList(input)` — each generates a correlation id via `crypto.randomUUID` (or injected fn), stores `{resolve, reject, timer}` in a module-level `Map<string, PendingEntry>`, sends the envelope via `relayClient.send()`, awaits, cleans the map on both settle paths.
    - Per-attempt timeout defaults to 5000ms; on expiry, reject with `QueryUnreachableError({attempts:1, lastReason:'correlation-id timeout after Nms'})`.
    - Relay-disconnected at send time (`getRelayClient()` returns null): immediate reject with `QueryUnreachableError`.
    - `onRelayMessage(msg: RelayMessage)`: if `msg.type !== 'gate_query_response'`, return; look up correlation id; missing → drop silently (stale response); present → validate `payload` shape via Zod; on `status:'error'`, reject with `QueryUnreachableError(lastReason: payload.error)`; on Zod fail, reject with `MalformedCloudResponseError`; else resolve with the normalized `QuerySingleResult` / `QueryListResult`.
    - Guard against payload's inner `mode` mismatching the request's `mode` → reject with `MalformedCloudResponseError` (per gate-query-relay-envelope.md cross-field rules).
  - Orchestrator-side is **single-attempt**; outer retry loop is the query-client's responsibility (per get-cockpit-gates.md § Retry semantics).

- [X] T021 [US1] Add `packages/orchestrator/src/services/__tests__/gate-status-query.test.ts` covering the eight cases in contracts/get-cockpit-gates.md § Service-level tests:
  - Single-mode round-trip.
  - List-mode round-trip.
  - Correlation-id mismatch → dropped silently; original promise remains pending.
  - Timeout → rejects with `QueryUnreachableError`.
  - Relay disconnected (`getRelayClient()` returns null) → immediate `QueryUnreachableError`.
  - Cloud error response (`status:'error', error:'firestore down'`) → `QueryUnreachableError` with `lastReason:'firestore down'`.
  - Malformed response (missing `payload` on `status:'ok'`) → `MalformedCloudResponseError`.
  - Concurrent requests: 3 in flight with 3 distinct correlation ids all resolve on their own responses (INV-2 concurrency).

- [X] T022 [P] [US1] Modify `packages/orchestrator/src/types/relay.ts` (if it re-exports envelope types) to surface `GateQueryRequestMessage` and `GateQueryResponseMessage` from `@generacy-ai/cluster-relay`. If the file only re-exports payloads, no change required — trust the compiler.

- [X] T023 [US1] Add the `GET /cockpit/gates` handler to `packages/orchestrator/src/routes/cockpit-gates.ts` per contracts/get-cockpit-gates.md § Handler logic:
  - Validate query params: reject with 400 `code:'VALIDATION'` when `issueRef` missing or `mode` not in `{single,list}`.
  - `mode=single` REQUIRES `gateType` AND `generation` → 400 with `code:'VALIDATION'` listing missing fields.
  - Delegate to `options.getQueryService()` — matching the existing route-setup dep pattern in this file.
  - Map `QueryUnreachableError` → 503 `code:'QUERY_UNREACHABLE'` with `details:{attempts, lastError}`.
  - Map `MalformedCloudResponseError` → 500 `code:'MALFORMED_RESPONSE'` with `details:{issues}`.
  - Handler stays thin — all correlation/timeout logic lives in the service (T020).

- [X] T024 [US1] Extend `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` per contracts/get-cockpit-gates.md § Route-level tests:
  - Missing `issueRef` → 400 `code:'VALIDATION'`.
  - `mode=single` missing `gateType` → 400.
  - `mode=list` happy → 200 with `{gates:[...]}`.
  - `mode=single` happy → 200 with `{gateId, status}`.
  - Service throws `QueryUnreachableError` → 503 `code:'QUERY_UNREACHABLE'`.
  - Service throws `MalformedCloudResponseError` → 500 `code:'MALFORMED_RESPONSE'`.
  - `mode=list` with `gateType` query param → passes through as `gateTypeFilter` to `queryList`.

- [X] T025 [US1] Wire `GateStatusQueryService` into `packages/orchestrator/src/server.ts` per contracts/get-cockpit-gates.md § Wiring:
  - Instantiate the service after the relay bridge is initialized (`initializeRelayBridge()` or the sibling seam per Wizard-Mode Relay Bridge Fix #598).
  - Register `service.onRelayMessage.bind(service)` with the inbound-message dispatcher on the relay bridge (same seam that today handles `api_request` / `event`).
  - Pass `getQueryService: () => gateStatusQuery` into the existing `setupCockpitGatesRoute(...)` options object. Do NOT introduce a new setup function — extend the existing one.
  - Verify wizard-mode path also wires this correctly (route registration must happen before `server.listen()` — mirror the fix from #598 if the current wiring is post-listen).

## Phase 4: MCP surface (`@generacy-ai/generacy`)

Depends on Phase 1 (uses new cockpit shapes) and Phase 3 (calls the GET route). Tests can be authored in parallel once schemas exist.

- [X] T030 [US1] Extend `ErrorClass` union in `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` with `'query-unreachable'` (per plan.md § R3 error class registration, data-model.md §7). Preserve the existing 12 members; add exactly one. No changes to `wrapToolBoundary` — per R3, the two new tools do their own mapping inside `query-client.ts`.

- [X] T031 [US1] Add the six new Zod schemas + inferred types to `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` per data-model.md §1–§3:
  - `GateStatusSchema = z.enum(['open','answered','absent'])` + `type GateStatus`.
  - `GateStatusInputSchema` (`.strict()` — issueRef, gateType, generation as `string | number`) + `type GateStatusInput`.
  - `GateStatusResponseSchema` (`gateId: z.string().length(24)`, `status: GateStatusSchema`) + `type GateStatusResponse`.
  - `GateListInputSchema` (`.strict()` — issueRef, optional gateType) + `type GateListInput`.
  - `GateListItemSchema` (`gateId`, `gateType`, `status: z.enum(['open','answered'])` — NOT absent per data-model.md §3) + `type GateListItem`.
  - `GateListResponseSchema` (`gates: z.array(GateListItemSchema)`) + `type GateListResponse`.
  - Reuse the existing `GateTypeSchema` import (already in the file for `GateOpenInputSchema`).

- [X] T032 [P] [US1] Re-export the two new input schemas from `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` (or wherever `CockpitGateOpenInputSchema` is re-exported for MCP `registerTool` sites) so `mcp/server.ts` can import them at registration time.

- [X] T033 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts` — GET-shaped HTTP client per plan.md § R9 and contracts/cockpit_gate_status.md § Retry semantics:
  - Import `resolveGateOptions` from `./options.ts` (share the existing options bag — no new fields).
  - Constants (data-model.md §6): `const RETRY_BACKOFFS_MS = [500, 1500, 3000] as const;` `const RETRY_JITTER_FRACTION = 0.1;` `const PER_ATTEMPT_TIMEOUT_MS = 5000;` (already the `resolveGateOptions.timeoutMs` default).
  - Export `queryGateStatus(input, opts): Promise<GateStatusResponse | { class: ErrorClass; detail: string }>`.
  - Export `queryGateList(input, opts): Promise<GateListResponse | { class: ErrorClass; detail: string }>`.
  - Retry loop: 3 attempts on HTTP 5xx / network error / `AbortError` / response Zod validation failure. Jittered backoff between attempts. HTTP 4xx is NOT retried — maps immediately.
  - On exhaustion → return `{ class: 'query-unreachable', detail: 'query unreachable after 3 attempts: <lastReason>' }` (INV-2, never `absent`).
  - On HTTP 400 → `class: 'invalid-args'`.
  - On response validation failure (all 3 attempts return HTTP 200 but Zod fails) → `class: 'internal'` (per contracts/cockpit_gate_status.md § Error class table).
  - Optional test-only export `_TEST_RETRY_BACKOFFS_MS` to allow fast-forward in unit tests (per data-model.md §6).
  - URL construction: single-mode → `?issueRef=<enc>&mode=single&gateType=<t>&generation=<g>`; list-mode → `?issueRef=<enc>&mode=list[&gateType=<t>]`.

- [X] T034 [US1] Add `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/query-client.test.ts` covering the R10 retry cases:
  - Success on first attempt → returns parsed response with no retries.
  - Success after 1 retry (attempt 1 HTTP 503, attempt 2 HTTP 200) → returns response.
  - Success after 2 retries (attempts 1+2 HTTP 503, attempt 3 HTTP 200) → returns response.
  - Retry exhaustion (all 3 HTTP 503) → `{ class:'query-unreachable', detail:... }`.
  - Network error on all 3 → `{ class:'query-unreachable' }` (proves INV-2 — never `absent`).
  - HTTP 400 → `{ class:'invalid-args' }` — no retry.
  - HTTP 200 with malformed body on all 3 → `{ class:'internal' }`.
  - Per-attempt timeout — inject a fetch that never resolves; assert `AbortError` fires at 5000ms and the loop treats it as retryable transport failure.
  - Cadence — assert backoff delays are ~500ms / 1500ms / 3000ms ±10% jitter (use fake timers).

- [X] T035 [US3] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.ts` per contracts/cockpit_gate_status.md:
  - Export `cockpitGateStatus(args, deps)` that:
    1. Validates `args` against `GateStatusInputSchema` (Zod boundary → `invalid-args` on failure).
    2. Coerces `generation` to string for the URL.
    3. Calls `queryGateStatus({issueRef, gateType, generation}, deps)`.
    4. On success returns `{status:'ok', data:{gateId, status}}` (`ToolResult<GateStatusResponse>` envelope).
    5. On error returns `{status:'error', class, detail}`.
  - Follows the same pattern as `tools/cockpit_gate_open.ts` for envelope + `toCallToolResult` wrapper.

- [X] T036 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts` per contracts/cockpit_gate_list.md:
  - Export `cockpitGateList(args, deps)` that:
    1. Validates `args` against `GateListInputSchema` (`invalid-args` on Zod failure).
    2. Calls `queryGateList({issueRef, gateType}, deps)` — passing `gateType` through so the query-client encodes it as the query param that the orchestrator route uses as `gateTypeFilter`.
    3. Filters the returned `gates[]` client-side by `gateType` when the input `gateType` is set (guards against a cloud responder that ignores the optional filter).
    4. On success returns `{status:'ok', data:{gates}}`.
    5. Empty `gates:[]` is a legal success — NOT an error (US3 acceptance, contracts/cockpit_gate_list.md § Empty-list semantics).
    6. INV-2: on `query-unreachable`, NEVER downgrade to `{gates:[]}`; propagate the error class.

- [X] T037 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit_gate_status.test.ts` per contracts/cockpit_gate_status.md § Test coverage — cover all 10 listed cases (happy `open`/`absent`/`answered`; terminal-negative `superseded` mapping to `absent`; missing `issueRef`; extra field; retry success on attempt 3; retry exhaustion; never-`absent` guarantee; malformed cloud payload → `internal`).

- [X] T038 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit_gate_list.test.ts` per contracts/cockpit_gate_list.md § Test coverage — cover all 10 listed cases (happy 3-item list; empty list no-throw; client-side `gateType` filter; `delivered → answered` mapping; missing `issueRef`; unknown enum; retry success; retry exhaustion; never-empty-list on transport failure; malformed item → `internal`).

- [X] T039 [US1] Register both new tools in `packages/generacy/src/cli/commands/cockpit/mcp/server.ts` immediately after the existing `cockpit_gate_open` / `cockpit_gate_ack` registrations (currently around `:194-216`):
  - `server.registerTool('cockpit_gate_status', {description:..., inputSchema: CockpitGateStatusInputSchema}, handler)` — description verbatim from contracts/cockpit_gate_status.md § Registration.
  - `server.registerTool('cockpit_gate_list', {description:..., inputSchema: CockpitGateListInputSchema}, handler)` — description verbatim from contracts/cockpit_gate_list.md § Registration.
  - Each handler wraps its tool with `toCallToolResult(await cockpitGateXxx(args, deps))` — same pattern as existing tools.
  - No CLI twin (per R8 — do NOT add corresponding entries to the CLI Commander program).

## Phase 5: Integration harness + release plumbing

- [X] T040 [US1] Extend `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts` (the #1024 harness) with one status-query scenario per plan.md § R10 § Integration:
  - Fake peer registers a `gate_query_request` handler that responds with a fabricated `gate_query_response` (both single and list modes).
  - Assert: orchestrator's `GET /cockpit/gates?mode=list&...` returns the expected 200 JSON.
  - Assert: MCP tool `cockpit_gate_list` (invoked through the harness's MCP path) returns the expected `ToolResult<GateListResponse>`.
  - Reuse the harness's existing WebSocket fake peer + tempdir-per-scenario pattern; do not fork a second fake peer.

- [X] T041 [US1] Add `.changeset/1038-cockpit-gate-status-query.md` per plan.md § R11:
  - `@generacy-ai/generacy` — **minor** (new MCP tools + new orchestrator route).
  - `@generacy-ai/cockpit` — **minor** with a `## Breaking changes` section documenting the `deriveClarificationGeneration` input-shape change; include the before/after snippet from quickstart.md § "deriveClarificationGeneration — the new canonical hash".
  - `@generacy-ai/cluster-relay` — **patch** (additive envelope types, no removed types).
  - Single file listing all three packages (CLAUDE.md gate — "list every package whose non-test src/ changed").

- [X] T042 [US1] Append a feature summary block to `/workspaces/generacy/CLAUDE.md` under a new `## Cockpit gates — read-only status query + stable clarification generation (#1038)` heading, matching the format of the existing `## Cockpit gates — cluster-side end-to-end integration harness (#1024, planning phase)` block. Cover: the two MCP tools + GET route + relay envelope pair, the breaking `deriveClarificationGeneration` shape change, INV-1 through INV-7, and the "sweep primitive is `cockpit_gate_list` by prefix" note.

## Phase 6: Verification

- [X] T050 [US1] Run the full package test suites and confirm green: `pnpm --filter @generacy-ai/cockpit test`, `pnpm --filter @generacy-ai/cluster-relay test`, `pnpm --filter @generacy-ai/orchestrator test`, `pnpm --filter @generacy-ai/generacy test`. Every new test (T003, T012, T021, T024, T034, T037, T038, T040) MUST pass; the SC-002 parity fixture (T003) is load-bearing — if it fails, the sweep-vs-live coalescing invariant is broken.

- [ ] T051 [manual] [US1] Local smoke: build the CLI (`pnpm --filter @generacy-ai/generacy build`), start a cluster (`generacy up`) with the new orchestrator, open Claude Code with the cockpit MCP plugin loaded, run `/mcp`, confirm **both** `cockpit_gate_status` AND `cockpit_gate_list` appear in the tool list (SC-004). Without the generacy-cloud sibling deployed, expect a `class:'query-unreachable'` result on invocation — that in itself proves the retry loop and the fail-loud invariant (INV-2) are wired.

## Dependencies & Execution Order

**Sequential phase boundaries** (each phase depends on the previous):

1. **Phase 1** (T001–T003) — `@generacy-ai/cockpit` shape change lands first; without it, Phase 4's schemas and the SC-002 parity fixture cannot exist.
2. **Phase 2** (T010–T012) — parallel with Phase 1 (different package graph), but MUST land before Phase 3 which imports the new envelope types.
3. **Phase 3** (T020–T025) — orchestrator service + route. T020 blocks T021 and T023; T023 blocks T024; all block T025.
4. **Phase 4** (T030–T039) — MCP surface. T030+T031 block T033; T033 blocks T034+T035+T036; T035+T036 block T037+T038; T039 depends on T035+T036.
5. **Phase 5** (T040–T042) — integration + release. T040 depends on Phase 3+Phase 4. T041 and T042 depend on all preceding source changes.
6. **Phase 6** (T050–T051) — verification, sequential.

**Parallel opportunities**:

- Within Phase 2: T010, T011, T012 are effectively parallelizable (T011 only re-exports what T010 defines — same PR file group, so treat as sequential in practice).
- T022 [P] can land alongside T020 (independent file).
- T032 [P] can land alongside T031 (independent file).
- T037 [P] and T038 [P] can be authored concurrently once T035 and T036 exist.
- **Phases 1 and 2 are parallel to each other** — different packages, no cross-imports.

**Load-bearing tests** (do not skip / weaken):

- T003 — the parity fixture is the ONLY test that catches sweep-vs-live drift (SC-002, INV-1).
- T021 — the concurrency case proves the correlation-id map does not cross wires under load.
- T034 — the never-`absent` retry-exhaustion case proves INV-2 end-to-end.
- T040 — the integration scenario proves the wire (envelope→route→service→client→tool) end-to-end against a live fake peer, catching seam bugs unit tests miss (per #1024 rationale).

**Cross-repo coordination reminders** (informational only — out of scope here):

- `generacy-ai/generacy-cloud` sibling ships the `gate_query_request` Firestore responder. Without it, every real query returns `class:'query-unreachable'` after the retry loop — expected until that sibling merges.
- `generacy-ai/agency` sibling replaces the `generation=1` hard-code in `packages/claude-plugin-cockpit/commands/auto.md:198` and inserts the `cockpit_gate_list` skip-drafting check per INV-5.

No `packages/claude-plugin-cockpit/commands/*.md` files exist in this repo — playbook re-pin task is not applicable here (playbook edits live in the agency sibling PR).
