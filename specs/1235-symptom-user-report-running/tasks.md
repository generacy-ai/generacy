# Tasks: cockpit_gate_open returns an inbox URL for /cockpit:auto to print

**Input**: Design documents from `/specs/1235-symptom-user-report-running/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/inbox-url.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

All paths are under `packages/generacy/src/cli/commands/cockpit/mcp/` unless noted.

## Phase 1: Foundation (shared primitives — blocks everything else)

- [ ] T001 [US1] Add `appUrl: string` to `GateClientOptions` and extend `resolveGateOptions(deps, env)`
  to resolve `deps.appUrl ?? env['GENERACY_APP_URL'] ?? 'https://app.generacy.ai'` in
  `gates/options.ts`. Add `'appUrl'` to the `Pick<...>` on the `deps` param. Do not touch
  `QueryClientOptions` — the resolved bag must stay structurally assignable to it.
- [ ] T002 [US1] Add optional `appUrl?: string` to `BuildMcpServerDeps` in `server.ts` and thread it
  into the `resolveGateOptions` call (new injection point, mirrors `orchestratorUrl`).
- [ ] T003 [P] [US1] Create `gates/inbox-url.ts` exporting
  `buildInboxUrl(appUrl: string, gateId: string): string`, implemented via
  `new URL('/dashboard/inbox', appUrl)` + `searchParams.set('gate', gateId)` for trailing-slash
  safety. Pure/synchronous; import nothing from the gate write path (observer-independence).

## Phase 2: Core — gate-open return shape (US1)

- [ ] T010 [US1] In `tools/cockpit_gate_open.ts`, add required `inboxUrl: string` to
  `CockpitGateOpenData` and assign it in the success return via
  `buildInboxUrl(options.appUrl, gateId)`, spread **last** (after `...envelope.data`) so an
  ack passthrough field cannot clobber it. Present on both `open` and `retained` results.

## Phase 3: Core — read-tool enrichment (US2)

- [ ] T020 [US2] Create `gates/query-schemas.ts` declaring MCP-facing output types next to the wire
  types: `CockpitGateStatusResult` (`{gateId:string; status:'open'|'answered'; inboxUrl:string}`
  | `{gateId:null; status:'absent'; inboxUrl:null}`), `CockpitGateListEntryResult`
  (`CockpitGateListEntry & { inboxUrl: string }`), and
  `CockpitGateListResult` (`{ gates: CockpitGateListEntryResult[]; truncated?: boolean }`).
  Keep the file import-disjoint from the write-path `schemas.ts`. Wire schemas in
  `gates/query-schemas.ts`/`query-client.ts` that `decodeResponse` parses stay unchanged.
- [ ] T021 [US2] In `tools/cockpit_gate_status.ts`, enrich after decode: gateId-bearing results
  (`open`/`answered`) get `inboxUrl: buildInboxUrl(options.appUrl, data.gateId)`; the `absent`
  branch (`gateId: null`) carries `inboxUrl: null`. Switch the handler's `ToolResult<T>` generic
  to `CockpitGateStatusResult`.
- [ ] T022 [US2] In `tools/cockpit_gate_list.ts`, map every row (any status) to
  `{ ...entry, inboxUrl: buildInboxUrl(options.appUrl, entry.gateId) }`. Switch the handler's
  `ToolResult<T>` generic to `CockpitGateListResult`.

## Phase 4: Tests (parity + unit)

- [ ] T030 [P] [US1] Add `gates/__tests__/inbox-url.test.ts`: assert template shape, trailing-slash
  `appUrl` normalisation (no `//dashboard`), and `encodeURIComponent` behaviour on the gate id.
- [ ] T031 [P] [US1] Add/extend `gates/__tests__/options.test.ts`: assert the `appUrl` precedence
  chain (`deps.appUrl` > `GENERACY_APP_URL` > `https://app.generacy.ai`) using the existing
  injected-`env` seam (no `process.env` mutation).
- [ ] T032 [P] [US1] In `__tests__/parity-gate-open.test.ts`, pin
  `inboxUrl === 'https://app.generacy.ai/dashboard/inbox?gate=' + EXPECTED_ID` on both `open` and
  `retained` acks. **Rewrite** the existing "passthrough response field forwarded (e.g. inboxUrl)"
  test to assert an echoed `inboxUrl` in the ack is now overridden by the local derivation.
- [ ] T033 [P] [US2] In `__tests__/parity-gate-status.test.ts`, pin `inboxUrl` present on
  `open`/`answered` and `inboxUrl: null` on `absent`.
- [ ] T034 [P] [US2] In `__tests__/parity-gate-list.test.ts`, pin that every returned row carries
  `inboxUrl` derived from its own `gateId`.
- [ ] T035 [US1] Confirm `__tests__/observer-independence.test.ts` still passes with both read tools
  importing `gates/inbox-url.js` (no code change expected; fix an import if the scan trips).

## Phase 5: Release gate & verification

- [ ] T040 [US1] Add `.changeset/1235-gate-inbox-url.md` — newly-added file, `@generacy-ai/generacy`
  `patch` (`workflow:speckit-bugfix`; new types not re-exported from `index.ts` → internal
  surface → patch). Required by the CI changeset gate.
- [ ] T041 [US1] Rebuild `@generacy-ai/generacy` (`dist/`) then run the package's typecheck and the
  gate test files above (`pnpm --filter @generacy-ai/generacy test`). All green before pushing.

## Dependencies & Execution Order

- **Phase 1 blocks all later phases**: T001 (options) and T003 (`inbox-url.ts`) supply `appUrl`
  and `buildInboxUrl` used by every tool. T002 depends on T001 (same `resolveGateOptions` call
  site). T003 is independent of T001/T002 → `[P]`.
- **Phase 2 and Phase 3 are independent** once Phase 1 lands (different tool files), but T021/T022
  both depend on T020 (shared output-type file).
- **Phase 4** depends on the code it pins: T030/T031 need Phase 1; T032 needs T010; T033 needs
  T021; T034 needs T022. The six test files touch distinct files → all `[P]` relative to each
  other.
- **Phase 5** is last: T041 validates the whole change; T040 can be written any time but is grouped
  here as the pre-push gate.

**Parallel opportunities**: T003 alongside T001/T002; all of T030–T034 in parallel once their
targets exist.

**Note**: No `packages/claude-plugin-cockpit/commands/*.md` playbook is edited by this issue
(`auto.md` edits are explicitly out of scope — agency follow-up), so no playbook-verification
re-pin task applies.
