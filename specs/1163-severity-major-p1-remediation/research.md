# Research: Add `remediation-limit` + `ci` to the cockpit gate wire schema

Issue: generacy-ai/generacy#1163 · Branch: `1163-severity-major-p1-remediation`

## Decision 1 — Two enums, not one

**Decision**: Widen BOTH `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:34-43`
(MCP-boundary mirror) AND `packages/cockpit/src/gates/schema.ts:24-33` (canonical
`@generacy-ai/cockpit`).

**Rationale** (clarify Q2→A): the orchestrator route
`packages/orchestrator/src/routes/cockpit-gates.ts` imports `GateOpenSchema` / `GateTypeSchema` from
`@generacy-ai/cockpit` and re-parses every forwarded gate-open (`GateOpenSchema.parse`). A gate that
clears the MCP mirror would still be rejected at the route if only the mirror were widened. Both must
add the value.

**Alternatives rejected**: MCP mirror only (FR-001's literal wording) — leaves the gate rejected at
the route; the fix would silently pass its own MCP-boundary test yet fail end-to-end.

## Decision 2 — Add both `remediation-limit` and `ci` now

**Decision**: Ship both members in a single coordinated enum bump.

**Rationale** (clarify Q1→A): `ci` (#1133) is an operator-answerable worker gate with the *identical*
`--gates=ui` dead-gate exposure. Both need the same one-line addition to the same two enums;
deferring `ci` merely re-opens the identical rejection for a second gate type. The audit of
#1120/#1153 operator-answerable worker gates yields only these two net-new candidates: `review` ships
gate-less and `implementation-review` is already an enum member.

## Decision 3 — Append at the end; do not reorder

**Decision**: Append `remediation-limit` then `ci` after `scope-drained` in both enums.

**Rationale**: FR-004 forbids reordering/renaming the existing 8 (they mirror the cloud enum
field-for-field). Both mirror files carry an "order preserved to match the cloud enum" comment; the
cloud enum is grown additively, so appending is the compatible convention. The cloud
`cockpitGateTypeEnum` change is coordinated separately (Assumptions / Out of Scope) — this cluster
fix is necessary but not sufficient for end-to-end delivery, and the *relative order of the existing
8* is what must not drift, not the absolute position of the two additions.

## Decision 4 — Plain-string generations, no new derivation helper

**Decision**: In `fixtures.ts` `GENERATIONS`, give the two new types plain string literals
(`remediation-limit` → `'1'` cap-round counter; `ci` → `'abc1234'` head SHA) rather than adding
`deriveRemediationLimitGeneration` / `deriveCiGeneration` helpers to `generation.ts`.

**Rationale**: Spec Assumption — "No new gate-identity derivation logic is required; the new gate
type flows through the existing derivation unchanged." Out of Scope explicitly excludes gate-identity
derivation changes. `deriveGateKey`/`deriveGateId` are gate-type-agnostic (they string-join and
sha256), so a fixture only needs *some* valid generation string. A plain literal is the minimal,
in-scope choice. A dedicated helper would be net-new derivation surface for no functional gain.

**Alternative rejected**: add per-type helpers for symmetry with the existing 8 — expands scope into
the derivation layer the spec fences off, and the two engine-side gates already compute their own
discriminators upstream (remediation counter, CI head SHA) that a helper would only re-wrap.

## Decision 5 — The exhaustiveness cascade is TypeScript-enforced

**Finding**: `packages/cockpit/src/gates/index.ts` exports
`GATE_TYPES = GateTypeSchema.options`. `fixtures.ts` declares four `Record<GateType, …>` maps —
`GENERATIONS`, `VALID_FIXTURES`, `ANSWER_SPECS`, `VALID_ANSWER_FIXTURES`. Widening the canonical enum
makes all four fail to type-check until each gains a `remediation-limit` and `ci` entry. This is the
compiler doing the "did you cover every gate type?" audit for free — no separate audit test needed on
the canonical side. Module-load `parse` loops additionally validate the new fixtures at build time.

The MCP mirror (`schemas.ts`) has **no** such exhaustive consumer — its enum widening is a genuine
one-line edit with an added explicit round-trip test.

## Decision 6 — Test strategy: auto-cover + explicit pin

**Decision**: Rely on the canonical `it.each([...GATE_TYPES])` block to auto-cover the new members
(it iterates `VALID_FIXTURES` / `VALID_ANSWER_FIXTURES`), AND add an explicit
`GateTypeSchema.safeParse('remediation-limit'|'ci')` accept assertion in each suite (FR-003 pins the
members by name so an accidental enum edit is caught with a readable failure). On the MCP mirror,
mirror the existing #1077 `frameId` regression style (inline valid record + `safeParse`).

## Constitution

No `.specify/memory/constitution.md` present → check skipped.

## Coordination / cross-repo (out of scope here, noted for the record)

- Cloud `cockpitGateTypeEnum` (generacy-cloud) must also accept both values or the forwarded record
  is dropped cloud-side — coordinated separately.
- Agency plugin `GateType` union
  (`claude-plugin-cockpit/lib/gate-wire-types.ts:105-113`) has the identical gap — tracked in a
  follow-up generacy-ai/agency issue.
- Both counterparts must land before UI-mode dogfood.
