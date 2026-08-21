# Feature Specification: Add `remediation-limit` to the cockpit gate wire schema

**Branch**: `1163-severity-major-p1-remediation` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: major (P1).** The engine-native review/remediate epic (generacy-ai/generacy#1120)
introduced a new operator gate, `remediation-limit`, that pauses a run once the remediation cap
is reached (`waiting-for:remediation-limit` + `agent:paused`). But the cluster-side cockpit
gate wire schema — `GateTypeSchema`, a closed 8-value Zod enum at
`packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:34-43` — has no
`remediation-limit` member.

Consequently, when `/cockpit:auto` runs under `--gates=ui`, every `cockpit_gate_open` /
`cockpit_gate_status` call that the slimmed auto playbook's D.13/G.9 flow issues for a
remediation-limit gate is rejected at the MCP boundary with `invalid-args` (the enum
`.strict()`-rejects the unknown `gateType`). The gate never reaches the operator inbox, so a
UI-mode operator cannot answer the cap gate at all. Local mode is unaffected (it does not route
through the wire schema).

Fix: add both `remediation-limit` and `ci` (the CI merge gate from #1133) to the gate-type
enum — both are operator-answerable worker gates with the identical `--gates=ui` dead-gate
exposure (clarified 2026-08-21, Q1→A). The addition must land in **both** in-repo mirrors of the
enum: the MCP-boundary schema at `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:34-43`
**and** the canonical `@generacy-ai/cockpit` enum at `packages/cockpit/src/gates/schema.ts:24-33`,
because the orchestrator route re-validates every forwarded gate-open via the package schema
(`GateOpenSchema.parse` at `cockpit-gates.ts:339`); updating only the MCP mirror leaves the gate
rejected at the route (clarified 2026-08-21, Q2→A). Add a schema round-trip test pinning the new
members.

**Coordination:** `GateTypeSchema` is the cluster-side mirror of the authoritative cloud
`cockpitGateTypeEnum` (see the schema file's DESIGN header). The agency plugin's own `GateType`
union (`claude-plugin-cockpit/lib/gate-wire-types.ts:105-113`) has the identical gap, tracked in
a follow-up issue in generacy-ai/agency. Both the cluster mirror and the cloud receiver must
accept the new value before UI-mode dogfood, or the cloud will drop the forwarded record even
after this cluster fix.

Filed from a post-merge code review of epic generacy-ai/generacy#1120. Part of follow-up epic
generacy-ai/generacy#1153. All line refs at develop `155b3464`.

## User Stories

### US1: UI-mode operator can answer the remediation-limit cap gate

**As a** cockpit operator running `/cockpit:auto` under `--gates=ui`,
**I want** the remediation-limit gate to be forwarded to my inbox instead of failing with
`invalid-args`,
**So that** I can approve or redirect a run that has hit the remediation cap rather than have it
stall silently.

**Acceptance Criteria**:
- [ ] `cockpit_gate_open` with `gateType: 'remediation-limit'` passes MCP input validation and
      the assembled record passes the outbound `GateOpenWireSchema` self-check.
- [ ] `cockpit_gate_status` / `cockpit_gate_ack` for a remediation-limit gate no longer return
      `invalid-args` on account of the gate type.
- [ ] A schema round-trip test asserts `GateTypeSchema` accepts `'remediation-limit'`.

### US2: Gate-type enum covers every operator gate the #1120 engine can raise

**As a** maintainer of the cockpit wire contract,
**I want** the gate-type enum to include every worker gate the review/remediate engine can raise
that must reach a human,
**So that** no #1120 gate is silently un-answerable under UI mode.

**Acceptance Criteria**:
- [ ] The set of engine-raisable operator gate labels from #1120 (at minimum
      `remediation-limit`; `ci` from #1133 evaluated during clarify) is reconciled against
      `GateTypeSchema`, and any missing member is added.
- [ ] The round-trip test covers each added member.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `remediation-limit` and `ci` as members of `GateTypeSchema` in the MCP mirror `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:34-43`. | P1 | Order relative to the existing 8 values must match the cloud enum ordering convention. |
| FR-002 | Add the same two members (`remediation-limit`, `ci`) to the canonical `@generacy-ai/cockpit` enum at `packages/cockpit/src/gates/schema.ts:24-33`, so the orchestrator route (`GateOpenSchema.parse`, `cockpit-gates.ts:339`) accepts the forwarded gate-open. | P1 | Resolved Q2→A: both enums required; expands changeset to bump `@generacy-ai/cockpit`. `ci` inclusion resolved Q1→A. |
| FR-003 | Add a schema round-trip test that asserts `GateTypeSchema` (and, transitively, `GateOpenWireSchema`/`GateOpenInputSchema`) accepts each newly added gate type, in both the MCP-mirror and the `@generacy-ai/cockpit` test suites. | P1 | Mirror the existing `mcp/gates/__tests__/schemas.test.ts` style; add matching coverage under `packages/cockpit/src/__tests__/`. |
| FR-004 | Keep both mirrors field-for-field compatible with the authoritative cloud enum — no reordering or renaming of the existing 8 values. | P1 | Cross-repo coordination noted in Assumptions. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `remediation-limit` and `ci` accepted by both gate-type enums | 100% | Round-trip tests green in both suites; `GateTypeSchema.safeParse('remediation-limit').success === true` and `…('ci').success === true` in the MCP mirror and `@generacy-ai/cockpit`. |
| SC-002 | UI-mode remediation-limit/ci gates no longer rejected at the MCP boundary or the orchestrator route | 0 `invalid-args`/route rejects from gate type | `cockpit_gate_open`/`_status`/`_ack` for a remediation-limit or ci gate validate at the MCP boundary and pass `GateOpenSchema.parse` at the route. |
| SC-003 | No regression on the existing 8 gate types | 0 removed/renamed members | Existing parity/schema tests remain green. |

## Assumptions

- The cloud `cockpitGateTypeEnum` will (or already does) accept `remediation-limit` and `ci`;
  without a matching cloud change the forwarded record is dropped cloud-side. This cluster fix is
  necessary but not sufficient for end-to-end UI-mode delivery — cloud + agency counterparts must
  land before UI-mode dogfood.
- `ci` (the CI merge gate from #1133) is confirmed in scope alongside `remediation-limit`
  (clarified Q1→A); the audit of #1120/#1153 operator-answerable worker gates yields only these
  two net-new candidates (`review` ships gate-less; `implementation-review` is already an enum
  member).
- `remediation-limit` is an operator-answerable gate (resumable pause), matching how the worker
  applies `waiting-for:remediation-limit` + `agent:paused` at the cap.
- No new gate-identity derivation (`deriveGateKey`/`deriveGateId`) logic is required; the new
  gate type flows through the existing derivation unchanged.

## Out of Scope

- The agency plugin `GateType` union fix (`claude-plugin-cockpit/lib/gate-wire-types.ts`) —
  tracked in a separate generacy-ai/agency issue.
- The cloud-side `cockpitGateTypeEnum` change (generacy-cloud) — coordinated separately.
- Any change to how the worker raises the `remediation-limit`/`ci` gates, or to the auto-playbook
  D.13/G.9 flow.
- Changes to gate identity derivation, gate-outcome enum, or presentation option schemas.

---

*Generated by speckit*
