# Feature Specification: `runId` on gate-query MCP tools (Phase B of #1053 fix)

**Branch**: `1067-problem-generacy-1053-s` | **Date**: 2026-07-29 | **Status**: Draft | **Issue**: [#1067](https://github.com/generacy-ai/generacy/issues/1067)

## Summary

The Phase B slice of the three-phase fix for the #1053 gate-re-open bug. #1053's write-side landed an optional `runId` on `cockpit_gate_open` / `cockpit_gate_ack`, but the corresponding **read-side** MCP tools (`cockpit_gate_status` and `cockpit_gate_list`) still reject the field structurally — their input schemas are `.strict()` with no `runId` declaration. As a result, `deriveGateKey` on the read path always uses the pre-#1053 3-tuple, and once a caller *does* start threading `runId` on the write side (Phase C), the read side silently misses every lookup: the sweep re-drafts on every wake, cloud rejects the duplicates as terminal, the inbox stays empty, and the loop wedges exactly as #1053 describes.

Widen the read-side MCP schemas to accept an **optional** `runId`, thread it through `services/cloud-gate-query-client.ts` to the cloud query, and add a regression that pins `cockpit_gate_open` and `cockpit_gate_status` to derive from the same inputs. With no `runId` supplied, every derived key and id is byte-identical to today (backward compatible; safe to ship alone once cloud Phase A has landed).

## Problem context

- **Bug reproduces today**: even after #1053 + #1055, a gate that reached a terminal cloud status (`applied`, `superseded`, `failed`, `expired`) permanently blocks its own re-open. A re-run of the same natural gate derives the identical `gateId` (`sha256(issueRef:gateType:generation)`) and the cloud log-drops the new open as terminal. Cluster gets a 202; inbox stays empty. Silent in both directions.
- **Root cause of the silence on the read side**: `CockpitGateStatusInputSchema` and `CockpitGateListInputSchema` at `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:20-29` and `:53-59` are both `.strict()` with no `runId` field. Any caller that passes one is rejected with `invalid-args` at the tool boundary, so no read-side call can ever match a 4-tuple gate.
- **Ordering dependency**: this is Phase B. Phase A (generacy-cloud, out of scope here) must land first — cloud accepts an optional `runId` on both write and read paths and stores `generation` as its own field. Landing Phase B before Phase A produces the exact silent failure described in generacy#1059: write becomes 4-segment while cloud derives 3-segment; every `cockpit_gate_status` lookup misses; pre-draft dedup invariant at `auto.md:283` breaks; drafting subagent re-runs on every wake; duplicate inbox gates; answers routed against a `gateId` the loop no longer tracks.
- **What flips the feature on**: Phase C, an agency-side change to `/cockpit:auto` that starts passing `runId` on both the open call and the subsequent status/list calls. Not in scope here.

## User Stories

### US1 (P1): Backward-compatibility on the no-`runId` path

**As** any existing caller of `cockpit_gate_status` or `cockpit_gate_list` (including agency's current `/cockpit:auto` sweep, which does not yet know about `runId`),
**I want** the tools to keep accepting my exact current input shape and returning byte-identical results,
**So that** shipping this change does not require simultaneous coordination with agency-side callers.

**Acceptance Criteria**:
- Passing the current 3-field input (`issueRef`, `gateType`, `generation`) or `list` input (`issueRef`, optional `gateType`) still validates.
- The URL emitted by `cloud-gate-query-client.ts` when no `runId` is passed is byte-identical to today.
- The gate key derivation that `cockpit_gate_open` uses when no `runId` is passed is byte-identical to today (already true; regression-pinned in US4).

### US2 (P1): The 4-tuple `runId` path is reachable end-to-end on the read side

**As** an agency-side caller that has started threading `runId` (Phase C),
**I want** to pass `runId` to `cockpit_gate_status` and get `open` for a gate I just opened in the same run with the same `runId`,
**So that** the sweep's pre-draft dedup check succeeds and I do not re-draft a duplicate.

**Acceptance Criteria**:
- `CockpitGateStatusInputSchema` accepts an optional `runId: z.string().min(1).optional()`.
- `CockpitGateListInputSchema` accepts an optional `runId: z.string().min(1).optional()`.
- Both schemas remain `.strict()` (the field is *declared*, not tolerated).
- `cloud-gate-query-client.ts` `getGateStatus()` and `listGates()` accept an optional `runId` and forward it as a query-string parameter to the cloud endpoint when present.
- With Phase A landed on the cloud side, calling `cockpit_gate_open({ ...triple, runId: X })` followed by `cockpit_gate_status({ ...triple, runId: X })` returns `open` (not `absent`).

### US3 (P1): `applied`-then-rerun opens a new inbox gate

**As** an operator re-running an epic/phase whose previous gate reached `applied`,
**I want** the sweep to see the new run as a fresh gate and put it in the inbox,
**So that** re-runs are not permanently blocked by prior terminal outcomes. (This is the #1053 acceptance criterion, currently unmet on any code path.)

**Acceptance Criteria**:
- With `runId=A` supplied on the first run, a natural gate reaches `applied`. With `runId=B ≠ A` supplied on the second run, `cockpit_gate_status` returns `absent` (or `open` after the sweep drafts), the sweep drafts a new gate, and the new gate is visible in the inbox.
- Without `runId` on either run (legacy path), behaviour is byte-identical to today — the second run is silently blocked. (Documenting the invariant; the fix ships as US2.)

### US4 (P1): `open` and `status` cannot disagree about identity for one logical gate

**As** the person maintaining these tools next quarter,
**I want** an automated regression that fails if `cockpit_gate_open` and `cockpit_gate_status` ever derive different keys/ids from the same inputs,
**So that** a future refactor cannot silently reintroduce the class of bug this spec closes.

**Acceptance Criteria**:
- A test asserts that for every combination of (`issueRef`, `gateType`, `generation`, `runId?`) supplied to both tools, the `gateKey` and `gateId` derived by `cockpit_gate_open` and the wire-side derivation used by the cloud lookup match.
- The test covers both the omitted-`runId` (3-tuple) and explicit-`runId` (4-tuple) cases.

### US5 (P2): MCP inputSchema remains flat

**As** an MCP client that lists tool schemas at boot (including the `--gates=ui` dogfood),
**I want** the two widened tools to still advertise a flat, non-empty `inputSchema`,
**So that** clients don't fall back to stringifying arguments (as they do when handed an intersection with no `.shape`).

**Acceptance Criteria**:
- Widening is done in-place on the existing `z.object({...}).strict()` schemas (adding a field), not via `z.intersection` or `z.and`.
- The generated `inputSchema` for both tools remains a flat object with a non-empty `properties` map.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                                | Priority | Notes                                                                                     |
|--------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-------------------------------------------------------------------------------------------|
| FR-001 | `CockpitGateStatusInputSchema` gains `runId: z.string().min(1).optional()`; schema remains `.strict()` and a flat `z.object`.                                                                                                                              | P1       | `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:20-29`.            |
| FR-002 | `CockpitGateListInputSchema` gains `runId: z.string().min(1).optional()`; schema remains `.strict()` and a flat `z.object`.                                                                                                                                | P1       | Same file, `:53-59`.                                                                      |
| FR-003 | `services/cloud-gate-query-client.ts` `GetGateStatusInput` and `ListGatesInput` gain optional `runId`; when present, forwarded as a URL query-string parameter on the cloud call.                                                                          | P1       | `packages/orchestrator/src/services/cloud-gate-query-client.ts`.                          |
| FR-004 | The `cockpit_gate_status` and `cockpit_gate_list` MCP tool handlers thread the optional `runId` from parsed input into the cloud query client call.                                                                                                        | P1       | `tools/cockpit_gate_status.ts:48-52` and `tools/cockpit_gate_list.ts:51-52`.              |
| FR-005 | With `runId === undefined`, every derived key, id, and outbound URL is byte-identical to the pre-change behaviour (verified by fixture comparison against pre-change snapshots).                                                                           | P1       | Backward-compat invariant; guards silent regressions on the legacy caller path.           |
| FR-006 | A regression test pins that `cockpit_gate_open` and `cockpit_gate_status` derive from the same inputs — same `gateKey` on both paths for both the 3-tuple and 4-tuple cases.                                                                               | P1       | Prevents #1053 recurrence.                                                                |
| FR-007 | No change to `cockpit_gate_open`, `cockpit_gate_ack`, `cockpit_gate_status`/`cockpit_gate_list` semantics beyond the schema widening + parameter threading. No new tools, no removed tools, no schema-shape reorganisation, no error-class changes.        | P1       | Keep the diff narrow to make review and rollback trivial.                                 |
| FR-008 | Structured log line at the tool boundary observes the `runId` source (`explicit` vs `unset`) for `cockpit_gate_status` and `cockpit_gate_list`, mirroring `cockpit_gate_open`'s existing `runIdSource` log field.                                          | P2       | Consistency with `cockpit_gate_open.ts:80-97`. `runId` value itself MUST NOT be logged.  |
| FR-009 | Observer-independence import-scan (existing) continues to pass — the query tools do not import from the write-path client, `cockpit_gate_open`, `cockpit_gate_ack`, or any `retain*` file.                                                                 | P1       | `mcp/__tests__/observer-independence.test.ts`. No new imports across the boundary.       |

## Success Criteria

| ID     | Metric                                                                                                    | Target                                              | Measurement                                                                                                             |
|--------|-----------------------------------------------------------------------------------------------------------|-----------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| SC-001 | No-`runId` byte-compat: outbound URL to cloud for `getGateStatus` with no `runId` matches pre-change.     | 100% (exact string match)                           | Snapshot test comparing pre-change and post-change URL construction for a canonical input.                              |
| SC-002 | No-`runId` byte-compat: `gateKey` derivation with no `runId` matches pre-change (already true).           | 100% (exact string match)                           | Existing tests pass unchanged; add explicit fixture in the new regression.                                              |
| SC-003 | 4-tuple path reaches the cloud: with `runId` supplied, the outbound URL contains `runId=<value>`.         | 100%                                                | Test with `httpsRequestImpl` seam that captures the request URL.                                                        |
| SC-004 | End-to-end: with cloud Phase A landed and `runId=X` supplied, `cockpit_gate_status` returns `open` after `cockpit_gate_open` with the same `runId`. | Passes in fake-cloud integration test               | Integration test using a fake cloud that persists gates by 4-tuple.                                                     |
| SC-005 | `cockpit_gate_open` and `cockpit_gate_status` derive matching `gateKey` for all 3-tuple and 4-tuple cases. | 100% (matrix test)                                  | Parameterised test over ≥4 combinations (3-tuple, 4-tuple, distinct `runId` values, empty `generation` boundary).       |
| SC-006 | MCP `inputSchema` for both widened tools remains a flat `z.object` with non-empty `properties`.           | Both tools pass the flat-schema assertion           | Assertion in the existing parity test suite (`parity-gate-status.test.ts`, `parity-gate-list.test.ts`).                 |
| SC-007 | Observer-independence import-scan unchanged.                                                              | Existing test passes without modification           | Run existing `observer-independence.test.ts`.                                                                           |
| SC-008 | Every callsite of `getGateStatus` / `listGates` compiles with the widened input type (optional `runId`).  | Zero TypeScript errors after change                 | `pnpm typecheck` passes.                                                                                                |

## Assumptions

1. **Cloud Phase A has landed** (generacy-cloud companion issue). The cloud endpoint accepts an optional `runId` on both `POST /api/clusters/:id/cockpit/gates` and `GET /api/clusters/:id/cockpit/gates`, and stores `generation` as its own field so 4-tuple write / 4-tuple read match. If Phase A has NOT landed, this PR must NOT merge — verified by the on-call reviewer at merge time.
2. **The MCP flat-schema constraint holds unchanged**: an intersection has no `.shape` and produces an empty advertised input schema. Widening is done by adding a field to the existing `z.object`, not by intersection.
3. **`cockpit_gate_open` and `cockpit_gate_ack` are unchanged.** #1053 already added `runId` to their input schemas; that surface is stable.
4. **`generation` is opaque to the read side.** The cluster forwards it verbatim (`String(input.generation)`) — no changes to coercion or interpretation.
5. **`runId` is never logged as a value.** Only the source label (`explicit` / `unset`) is logged, matching the write-side pattern established by #1053 (data-model E-3).
6. **Ordering claim**: this change is safe alone provided Phase A has landed. It is not safe before Phase A (see spec context; producing silent write-4/read-3 mismatch).

## Out of Scope

- **Cloud-side changes** (Phase A) — separate issue in `generacy-ai/generacy-cloud`. This PR depends on it but does not modify cloud code.
- **Agency-side threading** (Phase C) — separate issue against `generacy-ai/agency` (`/cockpit:auto`). Once this PR lands, `runId` is *accepted*; nothing changes on wire behavior until agency starts *passing* it.
- **`INSTANCE_NONCE` or any process-scoped fallback for `runId`.** Explicitly rejected in #1053 review; do not reintroduce. `runId` is either supplied by the caller or omitted.
- **Changes to `cockpit_gate_open` / `cockpit_gate_ack` schemas or semantics.** #1053 already handled that surface. This PR is exclusively the read-side twin.
- **Retry policy, error classes, orchestrator route contracts, seven-to-three status collapse.** Untouched.
- **Any new MCP tools.** No `cockpit_gate_reopen` or equivalent — the whole point is that `runId` on `cockpit_gate_open` produces a fresh `gateId` naturally.
- **Observability beyond the `runIdSource` log field.** No new metrics, no new event shapes on the cloud channel.

## Provenance

- Split from generacy#1059 (step 4).
- Depends on the `generacy-ai/generacy-cloud` Phase A issue (cloud read/write acceptance of optional `runId`).
- Unblocks generacy#1053 (once this PR and cloud Phase A both land, and agency Phase C starts passing `runId`).

---

*Generated by speckit; enhanced by /specify on 2026-07-29.*
