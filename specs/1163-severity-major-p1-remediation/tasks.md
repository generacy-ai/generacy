# Tasks: Add `remediation-limit` + `ci` to the cockpit gate wire schema

**Input**: Design documents from `/specs/1163-severity-major-p1-remediation/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md, quickstart.md, contracts/gate-type-enum.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Enum Widening

- [X] T001 [P] [US1] Append `'remediation-limit'` (after `scope-drained`) then `'ci'` to `GateTypeSchema` in the MCP-boundary mirror `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` (enum at lines 34-43). Do NOT reorder or rename the existing 8 members (FR-004 / INV-2). Add inline comments referencing #1120 (`waiting-for:remediation-limit`) and #1133 (`waiting-for:ci`).
- [X] T002 [US2] Append the identical two members (`'remediation-limit'` then `'ci'`, after `scope-drained`) to the canonical `GateTypeSchema` in `packages/cockpit/src/gates/schema.ts` (enum at lines 24-33). Keep byte-for-byte parity of the value list + order with the MCP mirror (INV-1). This drives `GATE_TYPES = GateTypeSchema.options` and will not type-check until T003 lands.

## Phase 2: Fixture Cascade (unblocks the canonical build)
<!-- Phase boundary: T002 makes the four exhaustive Record<GateType,…> maps fail to compile until this phase completes -->

- [X] T003 [US2] In `packages/cockpit/src/gates/fixtures.ts`, add a `remediation-limit` and a `ci` entry to each of the four exhaustive `Record<GateType, …>` maps:
    - `GENERATIONS` — plain strings: `'remediation-limit': '1'` (cap-round counter), `'ci': 'abc1234'` (head SHA). No `derive…Generation` helper (Out of Scope / Decision 4).
    - `VALID_FIXTURES` — `buildRecord('remediation-limit')`, `buildRecord('ci')`.
    - `ANSWER_SPECS` — an option-or-freetext answer spec for each (e.g. resume / redirect).
    - `VALID_ANSWER_FIXTURES` — `buildAnswer('remediation-limit')`, `buildAnswer('ci')`.
    Both new types resolve to the default `ISSUE_REF_STR` via `issueRefFor()` (only `phase-queue` is the epic-ref exception — do not touch it). Module-load `GateOpenSchema.parse` / `GateAnswerSchema.parse` loops validate these at build time.
- [X] T004 [US2] Prove the fixture cascade is complete: `pnpm --filter @generacy-ai/cockpit build` must type-check clean (all four Record maps exhaustive over the widened `GateType`).

## Phase 3: Tests
<!-- Phase boundary: enum + fixtures must exist before tests can pin them -->

- [X] T005 [P] [US1] Add a round-trip / accept test in `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/schemas.test.ts`, mirroring the existing #1077 `frameId` regression style: assert `GateTypeSchema.safeParse('remediation-limit').success === true` and `…('ci').success === true`, that `GateTypeSchema.safeParse('not-a-real-gate-type').success === false` (still closed), and that an inline valid record carrying each new `gateType` round-trips through `GateOpenWireSchema` / `GateOpenInputSchema` (SC-001, US1 AC1/AC2).
- [X] T006 [P] [US1] In `packages/cockpit/src/__tests__/gates-schemas.test.ts`, confirm the existing `it.each([...GATE_TYPES])` block auto-covers the new members (via T003 fixtures) and add an explicit `GateTypeSchema.safeParse('remediation-limit'|'ci')` accept assertion per type so the pin is visible by name (FR-003).

## Phase 4: Changeset & Verification
<!-- Phase boundary: land after all code + tests -->

- [X] T007 [P] Hand-write `.changeset/1163-gate-type-remediation-ci.md` as a NEWLY ADDED file (the CI gate greps `--diff-filter=A`): `@generacy-ai/cockpit` **minor** (new public wire-contract vocabulary on `GateTypeSchema`) and `@generacy-ai/generacy` **patch** (MCP-mirror widening, no new exported surface). Copy the shape of a comparable existing changeset.
- [X] T008 Run the full verification suite and confirm success criteria:
    - `pnpm --filter @generacy-ai/cockpit build` (fixture cascade complete).
    - `pnpm --filter @generacy-ai/cockpit test -- gates-schemas` (canonical, SC-001/SC-003).
    - `pnpm --filter @generacy-ai/generacy test -- mcp/gates` (MCP mirror, SC-001).
    - `pnpm changeset status` (changeset present + well-formed).
    - Confirm existing 8-type parity/derivation tests in `packages/cockpit/src/gates/__tests__/schema.test.ts` stay green — no member removed or renamed (SC-003).

## Dependencies & Execution Order

**Sequential backbone**:
- T002 (canonical enum) → T003 (fixtures) → T004 (build proof): T002 breaks the build until T003's four Record maps are complete; T004 confirms the cascade.
- T005/T006 (tests) require the enum + fixtures to exist (Phases 1–2 complete).
- T007 (changeset) is independent of test outcome but should land with the PR.
- T008 (verification) is the final gate — depends on everything above.

**Parallel opportunities**:
- T001 (MCP mirror) is a standalone one-line edit with no exhaustive consumer — it can run in parallel with the entire canonical-side cascade (T002→T004).
- T005 (MCP-mirror test) and T006 (canonical test) touch different files and can run in parallel once their respective code paths are in place.
- T007 (changeset) can be written at any point in parallel with the code edits.

**Invariants to uphold throughout** (contracts/gate-type-enum.md):
- INV-1: both mirrors carry the identical 10-value list in identical order.
- INV-2: members 1–8 are neither reordered nor renamed.
- INV-3: the two new members are appended after `scope-drained`.
- INV-4: cloud `cockpitGateTypeEnum` is authoritative and coordinated separately — this cluster fix is necessary but not sufficient for end-to-end UI-mode delivery.
