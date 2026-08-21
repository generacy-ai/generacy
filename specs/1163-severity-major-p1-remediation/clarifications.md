# Clarifications: Add `remediation-limit` to the cockpit gate wire schema

Issue: generacy-ai/generacy#1163

## Batch 1 — 2026-08-21

### Q1: Include the `ci` gate type
**Context**: FR-002 explicitly defers the decision on the CI merge gate (`ci`, from
#1133) to `/speckit:clarify`. `waiting-for:ci` is an operator-resumable pause (the worker
applies `waiting-for:ci` + `agent:paused` on CI-wait timeout), so under `--gates=ui` it has
the same `invalid-args` exposure as `remediation-limit` if the auto-playbook opens a
`gateType: 'ci'` gate for it. Adding `ci` also requires a matching cloud `cockpitGateTypeEnum`
change (same cross-repo coordination as `remediation-limit`). The audit of #1120/#1153
operator-answerable worker gates yields only two net-new candidates: `remediation-limit`
(confirmed in scope) and `ci`; `review` ships gate-less and `implementation-review` is already
an enum member.
**Question**: Should this change add `ci` to the gate-type enum(s) alongside `remediation-limit`,
or add only `remediation-limit` and defer `ci` to a separate coordinated issue?
**Options**:
- A: Add both `remediation-limit` and `ci` now (single coordinated enum bump).
- B: Add only `remediation-limit`; track `ci` as a separate follow-up.

**Answer**: *Pending*

### Q2: Second in-repo enum scope
**Context**: The spec's FR-001 names only the MCP-boundary mirror at
`packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:34-43`. But an identical
8-value `GateTypeSchema` also lives in the canonical `@generacy-ai/cockpit` package at
`packages/cockpit/src/gates/schema.ts:24-33`, and the orchestrator route re-validates every
forwarded gate-open through it: `cockpit-gates.ts:339` calls `GateOpenSchema.parse(request.body)`
(imported from `@generacy-ai/cockpit`), and `cockpit-gates.ts:61` validates
`cockpit_gate_status` queries via that package's `GateTypeSchema`. If only the MCP mirror is
updated, a `remediation-limit` gate clears the MCP boundary but is then rejected at the
orchestrator route — the fix is incomplete. Updating the package also expands the changeset to
bump `@generacy-ai/cockpit`.
**Question**: Should the fix update BOTH the MCP mirror (`schemas.ts`) and the canonical
`@generacy-ai/cockpit` enum (`packages/cockpit/src/gates/schema.ts`), given the orchestrator
route re-validates via the package schema?
**Options**:
- A: Update both enums (required for the gate to reach the cloud end-to-end).
- B: Update only the MCP mirror per FR-001's literal wording.

**Answer**: *Pending*
