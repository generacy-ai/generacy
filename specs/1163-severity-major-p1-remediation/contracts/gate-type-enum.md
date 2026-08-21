# Contract: cockpit gate-type enum — accepted values

Issue: generacy-ai/generacy#1163

Wire-contract change: two members appended to `GateTypeSchema`. This note pins the accepted set and
the invariants a reviewer / the generacy-cloud mirror must uphold.

## Accepted `gateType` values (post-change, order significant)

```
clarification
artifact-review
implementation-review
manual-validation
escalation
phase-queue
filing
scope-drained
remediation-limit   ← new (#1120)
ci                  ← new (#1133)
```

## Invariants

- **INV-1 (parity)**: both in-repo mirrors — MCP boundary
  (`packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`) and canonical
  `@generacy-ai/cockpit` (`packages/cockpit/src/gates/schema.ts`) — carry the identical 10-value
  list in the identical order.
- **INV-2 (no drift on the existing 8)**: members 1–8 are neither reordered nor renamed (FR-004,
  SC-003).
- **INV-3 (append convention)**: the two new members are appended after `scope-drained`, matching the
  cloud enum's additive-growth convention.
- **INV-4 (cloud is authoritative)**: these are mirrors. The cloud `cockpitGateTypeEnum`
  (generacy-cloud) is the receiver and must accept the same two values, in a compatible order, before
  the forwarded record is retained cloud-side. This contract is cluster-side only.

## Acceptance assertions

```ts
// both mirrors
GateTypeSchema.safeParse('remediation-limit').success === true;
GateTypeSchema.safeParse('ci').success === true;
GateTypeSchema.safeParse('not-a-real-gate-type').success === false; // still closed

// end-to-end (SC-002)
// cockpit_gate_open / _status / _ack with gateType ∈ {remediation-limit, ci}
//   → passes MCP input validation
//   → assembled record passes GateOpenWireSchema self-check
//   → passes GateOpenSchema.parse at the orchestrator route
```

## Non-goals (out of scope)

- Cloud `cockpitGateTypeEnum` change (generacy-cloud) — coordinated separately.
- Agency plugin `GateType` union (`claude-plugin-cockpit/lib/gate-wire-types.ts`) — follow-up
  generacy-ai/agency issue.
- Any change to gate-identity derivation, the gate-outcome enum, or presentation-option schemas.
