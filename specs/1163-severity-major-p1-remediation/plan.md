# Implementation Plan: Add `remediation-limit` + `ci` to the cockpit gate wire schema

**Feature**: Widen the cockpit gate-type wire enum (`GateTypeSchema`) with two operator-answerable worker gates — `remediation-limit` (#1120) and `ci` (#1133) — in both in-repo mirrors, so `--gates=ui` no longer rejects them with `invalid-args`.
**Branch**: `1163-severity-major-p1-remediation`
**Status**: Complete

## Summary

Two engine-raisable operator gates were added by the review/remediate epic — `remediation-limit`
(pauses at the remediation cap) and `ci` (the CI merge gate). Both are resumable pauses a UI-mode
operator must answer. But the cluster-side gate-type wire enum is a **closed 8-value Zod enum** that
lists neither, so under `/cockpit:auto --gates=ui` every `cockpit_gate_open`/`_status`/`_ack` for
those gates is `.strict()`-rejected with `invalid-args` at the MCP boundary and, even if it cleared
there, re-rejected at the orchestrator route.

The enum is mirrored in **two** in-repo locations, both of which must be widened (clarify Q1→A, Q2→A):

1. **MCP-boundary mirror** — `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:34-43`.
   Validates `cockpit_gate_open` input and the tool's outbound self-check.
2. **Canonical `@generacy-ai/cockpit` enum** — `packages/cockpit/src/gates/schema.ts:24-33`.
   The orchestrator route (`packages/orchestrator/src/routes/cockpit-gates.ts`) imports
   `GateOpenSchema`/`GateTypeSchema` from this package and re-parses every forwarded gate-open, so a
   gate that clears the MCP mirror is still rejected at the route unless this enum is widened too.

Both are field-for-field mirrors of the authoritative cloud `cockpitGateTypeEnum`; the existing 8
values are neither reordered nor renamed (FR-004). The two new members are **appended** after
`scope-drained`, preserving the "order preserved" convention. This cluster fix is necessary but not
sufficient for end-to-end UI-mode delivery — the cloud + agency counterparts (out of scope, tracked
separately) must also accept the values before dogfood.

## Technical Context

- **Language / runtime**: TypeScript, ESM. `@generacy-ai/generacy` (Node >=22), `@generacy-ai/cockpit`.
- **Schema library**: Zod (`z.enum`). No new dependency.
- **Test framework**: vitest.
- **Key insight — the cascade**: widening the *MCP mirror* enum (`schemas.ts`) is a standalone
  one-line edit — that file has no exhaustive `Record<GateType, …>` consumers. Widening the
  *canonical* enum (`schema.ts`) drives `GATE_TYPES = GateTypeSchema.options`
  (`packages/cockpit/src/gates/index.ts`), which is the exhaustiveness source for **four**
  `Record<GateType, …>` maps in `packages/cockpit/src/gates/fixtures.ts`. TypeScript will refuse to
  compile until all four gain entries for both new members.
- **No derivation change** (spec Assumption, Out of Scope): `deriveGateKey`/`deriveGateId` are
  gate-type-agnostic; the new types flow through unchanged. The four fixture maps supply
  **plain-string generations** for the new types (no new per-type `derive…Generation` helper) —
  keeping "gate identity derivation" strictly out of scope.

## Project Structure

Files changed:

```
packages/generacy/src/cli/commands/cockpit/mcp/gates/
  schemas.ts                              # EDIT  — append 2 enum members (34-43)
  __tests__/schemas.test.ts               # EDIT  — add MCP-mirror round-trip test

packages/cockpit/src/gates/
  schema.ts                               # EDIT  — append 2 enum members (24-33)
  fixtures.ts                             # EDIT  — 4 Record<GateType,…> maps gain 2 entries each
packages/cockpit/src/__tests__/
  gates-schemas.test.ts                   # EDIT/VERIFY — it.each([...GATE_TYPES]) auto-covers;
                                          #                add explicit accept assertion (FR-003)

.changeset/1163-gate-type-remediation-ci.md   # NEW — bump @generacy-ai/generacy + @generacy-ai/cockpit
```

Files deliberately **unchanged**:

- `packages/cockpit/src/gates/wire-fixtures.ts` — uses a single `DEFAULT_GATE_TYPE`, not exhaustive.
- `packages/cockpit/src/gates/gate-id.ts` — back-compat re-export shim; derivation untouched.
- `packages/cockpit/src/gates/generation.ts` — no new per-type helper (plain-string generations).
- `packages/orchestrator/src/routes/cockpit-gates.ts` — consumes the widened package enum
  transitively; no route edit needed.

## Enum edit (both mirrors, identical)

```ts
export const GateTypeSchema = z.enum([
  'clarification',
  'artifact-review',
  'implementation-review',
  'manual-validation',
  'escalation',
  'phase-queue',
  'filing',
  'scope-drained',
  'remediation-limit', // #1120 — remediation cap pause (waiting-for:remediation-limit)
  'ci',                // #1133 — CI merge gate (waiting-for:ci)
]);
```

## Fixture cascade (`packages/cockpit/src/gates/fixtures.ts`)

Add one entry per new type to each of the four exhaustive maps:

- `GENERATIONS` — plain strings: `'remediation-limit': '1'` (cap-round counter),
  `ci: 'abc1234'` (head SHA). No derivation helper.
- `VALID_FIXTURES` — `buildRecord('remediation-limit')`, `buildRecord('ci')`.
- `ANSWER_SPECS` — an option-or-freetext answer spec for each (e.g. resume / redirect).
- `VALID_ANSWER_FIXTURES` — `buildAnswer('remediation-limit')`, `buildAnswer('ci')`.

Both new types use the default `ISSUE_REF_STR` in `issueRefFor()` (only `phase-queue` is the
epic-ref exception — no change to that function). Module-load `GateOpenSchema.parse` /
`GateAnswerSchema.parse` loops then validate the new fixtures at build time.

## Test plan

- **MCP mirror** (`mcp/gates/__tests__/schemas.test.ts`): mirror the #1077 style — assert
  `GateTypeSchema.safeParse('remediation-limit').success === true` and `…('ci')`, and that a
  `GateOpenWireSchema` / `GateOpenInputSchema` record carrying each new `gateType` round-trips
  (SC-001, US1 AC1/AC2).
- **Canonical** (`packages/cockpit/src/__tests__/gates-schemas.test.ts`): the existing
  `it.each([...GATE_TYPES])` block auto-covers the new members once fixtures land; add an explicit
  `GateTypeSchema.safeParse` accept assertion per type (FR-003) so the pin is visible.
- **Regression** (SC-003): existing 8-type parity/derivation tests
  (`packages/cockpit/src/gates/__tests__/schema.test.ts`) stay green — no reorder/rename.

## Constitution Check

No `.specify/memory/constitution.md` in the repo → constitution check **skipped**.

## Changeset

`packages/generacy/src/` and `packages/cockpit/src/` both gain non-test changes → the CI changeset
gate requires a new `.changeset/*.md`. Bump both:

- `@generacy-ai/cockpit` — **minor** (new public wire-contract vocabulary on `GateTypeSchema`).
- `@generacy-ai/generacy` — **patch** (MCP-mirror widening; no new exported surface).

## Next step

`/speckit:tasks` to generate the task list.
