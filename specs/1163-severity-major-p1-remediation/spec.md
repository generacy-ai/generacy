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

Fix: add `remediation-limit` to `GateTypeSchema` and audit for any other gate type the #1120
engine can raise that the enum lacks (notably the CI merge gate, `ci`, from #1133). Add a
schema round-trip test pinning the new member(s).

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
| FR-001 | Add `remediation-limit` as a member of `GateTypeSchema` in `schemas.ts`. | P1 | Order relative to the existing 8 values must match the cloud enum ordering convention. |
| FR-002 | Audit the #1120 / #1153 engine for other operator gate types the enum lacks (candidate: `ci`) and add any confirmed-missing member. | P1 | Decision on `ci` deferred to `/speckit:clarify`. |
| FR-003 | Add a schema round-trip test that asserts `GateTypeSchema` (and, transitively, `GateOpenWireSchema`/`GateOpenInputSchema`) accepts each newly added gate type. | P1 | Mirror the existing `mcp/gates/__tests__/schemas.test.ts` style. |
| FR-004 | Keep the cluster mirror field-for-field compatible with the authoritative cloud enum — no reordering or renaming of the existing 8 values. | P1 | Cross-repo coordination noted in Assumptions. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `remediation-limit` accepted by the gate-type enum | 100% | Round-trip test green; `GateTypeSchema.safeParse('remediation-limit').success === true`. |
| SC-002 | UI-mode remediation-limit gate no longer rejected at the MCP boundary | 0 `invalid-args` from gate type | `cockpit_gate_open`/`_status`/`_ack` for a remediation-limit gate validate. |
| SC-003 | No regression on the existing 8 gate types | 0 removed/renamed members | Existing parity/schema tests remain green. |

## Assumptions

- The cloud `cockpitGateTypeEnum` will (or already does) accept `remediation-limit`; without a
  matching cloud change the forwarded record is dropped cloud-side. This cluster fix is necessary
  but not sufficient for end-to-end UI-mode delivery — cloud + agency counterparts must land
  before UI-mode dogfood.
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
