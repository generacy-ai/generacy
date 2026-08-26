# Quickstart: Add `remediation-limit` + `ci` to the cockpit gate wire schema

Issue: generacy-ai/generacy#1163

## What changes

Two members appended to the cockpit gate-type wire enum, in **both** in-repo mirrors, plus fixtures
and round-trip tests. After this, a `--gates=ui` operator can be forwarded (and answer) the
`remediation-limit` and `ci` gates instead of hitting `invalid-args`.

## The edits

1. **MCP mirror** — `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` (enum at
   34-43): append `'remediation-limit'`, `'ci'`.
2. **Canonical enum** — `packages/cockpit/src/gates/schema.ts` (enum at 24-33): append the same two.
3. **Fixtures** — `packages/cockpit/src/gates/fixtures.ts`: add a `remediation-limit` and `ci` entry
   to each of the four `Record<GateType, …>` maps (`GENERATIONS`, `VALID_FIXTURES`, `ANSWER_SPECS`,
   `VALID_ANSWER_FIXTURES`). Use plain-string generations (`'1'`, `'abc1234'`) — no new helper.
   > TypeScript will not compile step 2 until step 3 is complete — the four maps are exhaustive over
   > `GateType`.
4. **Tests** — add round-trip / accept assertions in
   `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/schemas.test.ts` and
   `packages/cockpit/src/__tests__/gates-schemas.test.ts`.
5. **Changeset** — hand-write `.changeset/1163-gate-type-remediation-ci.md`:
   `@generacy-ai/cockpit` **minor**, `@generacy-ai/generacy` **patch**.

## Run the checks

```bash
# build (proves the fixture cascade is complete — the exhaustive Record maps must type-check)
pnpm --filter @generacy-ai/cockpit build

# canonical gate schemas + fixtures
pnpm --filter @generacy-ai/cockpit test -- gates-schemas

# MCP-mirror wire schema
pnpm --filter @generacy-ai/generacy test -- mcp/gates

# changeset present + well-formed
pnpm changeset status
```

## Verify (success criteria)

- `GateTypeSchema.safeParse('remediation-limit').success === true` and `…('ci').success === true` in
  BOTH mirrors (SC-001).
- `cockpit_gate_open` / `_status` / `_ack` for a `remediation-limit` or `ci` gate validate at the MCP
  boundary and pass `GateOpenSchema.parse` at the orchestrator route — 0 `invalid-args` from the gate
  type (SC-002).
- Existing 8-type parity + derivation tests stay green; no member removed or renamed (SC-003).

## Not in this change

Cloud `cockpitGateTypeEnum`, the agency plugin `GateType` union, worker gate-raising logic, the
auto-playbook D.13/G.9 flow, and any gate-identity-derivation change — all out of scope / coordinated
separately.
