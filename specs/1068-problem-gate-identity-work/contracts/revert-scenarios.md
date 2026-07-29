# Contract: Per-phase revert scenarios (SC-002)

**Feature**: #1068 | **Related SC**: SC-002 | **Enforcement**: `packages/orchestrator/src/__tests__/cockpit-gates-runid.integration.test.ts` (NEW)

Per clarifications Q5=B, each of the seven verification items in the spec must map to at least one failing test assertion **with per-phase attribution** when the corresponding phase is reverted. This document catalogs the three revert cells, their harness realizations, and the assertions that fire.

## Revert cell #1 — Phase A (generacy-cloud) reverted

**Reverted behaviour**: cloud does not persist `generation` on the gate doc; `deriveGateKey` (cloud side) does not accept `runId` on read OR write paths.

**Harness realization** (fake-side, per FR-012):
```ts
ctx = await setupScenario({
  startFakeCloud: true,
  fakeCloudOptions: { persistGeneration: false },
});
```

`FakeCloudStore.putGateFromWireFrame` drops `generation` before insert; `getByKey` still runs `deriveGateKey(..., runId)` on the cluster's request but the store lookup fails because the doc was written with no `generation` in its key.

**Failing assertion** (attribution to Phase A):
- **FR-003** — first-post-Phase-A `cockpit_gate_status({ runId })` returns `absent` instead of `open`. **Attribution**: the fake-side `persistGeneration: false` mimics the exact Phase-A revert; the failing test is named `FR-003 (Phase A reverted): gate-status returns absent`.
- **FR-005** — `cockpit_gate_list` entries have `generation: '<pre-phase-a>'` sentinel instead of the input string. **Attribution**: same, named `FR-005 (Phase A reverted): generation renders as fallback`.

**Non-firing** (also fail-attributable): FR-002 (re-run makes distinct gateIds — still true by derivation), FR-006 (`frameId` — orthogonal), FR-007 (log line — orthogonal), FR-008 / FR-009 (backward compat — this IS Phase A revert, so passes trivially).

## Revert cell #2 — Phase B (generacy) reverted

**Reverted behaviour**: cluster's MCP tools ignore any incoming `runId` argument; outbound POST to `/cockpit/gates` and outbound query to `/api/clusters/.../cockpit/gates` do not include `runId`.

**Harness realization** (fake-side, per FR-012 — NOT a `SIMULATE_PHASE_B=1` env var):
```ts
// Every McpToolDriver call in this test block simply omits `runId`:
await ctx.mcp!.gateOpen({ issueRef, gateType, generation, ...requiredNonRunIdFields });
// (no `runId` field — under Q3=C this is not-passing an optional field)
```

`GateOpenInputSchema.runId: z.string().min(1).optional()` accepts the omission — no simulation flag needed.

**Failing assertion** (attribution to Phase B):
- **FR-002** — second-run `cockpit_gate_open` produces the SAME `gateId` as first-run because both keys derive without a `runId` suffix. Assertion fails: `expect(gateIdRun1).not.toBe(gateIdRun2)` — the fake cloud's `getByKey` returns the first-run's already-`applied` doc; second-run `cockpit_gate_status` returns `answered` for what should be a fresh gate. Test named `FR-002 (Phase B reverted): re-run collides with terminal-state applied gate`.
- **FR-003** — indirectly fails via FR-002. Named separately for attribution granularity.

## Revert cell #3 — Phase C (agency) reverted

**Reverted behaviour**: agency's `/cockpit:auto` playbook does not pass `runId` when invoking the MCP tools. From the harness's perspective this is identical to Phase B revert (both are "cluster's MCP tools called without `runId`") — the difference is *which layer* omits the argument. In production, Phase B is the tool accepting it; Phase C is the caller supplying it.

**Harness realization**: identical to Phase B — omit `runId` on every `McpToolDriver` call. The harness cannot distinguish between "tool ignores the field" (Phase B revert) and "caller doesn't pass the field" (Phase C revert) because it drives the tools directly (Q2=C — no `/cockpit:auto` process).

**Failing assertion**: same as Phase B — FR-002 and FR-003 fail on the second-run collision.

**Attribution note** (from clarifications Q5): "assert **attribution**, not just failure — the test that fails when Phase A is reverted should be the one about `generation` storage, not an unrelated cascade." For Phase C vs Phase B this attribution is inherently ambiguous inside this harness. Documented here so the reviewer knows: **the Phase C revert cell shares its test bodies with Phase B**, and the boundary between the two lives outside this harness (in agency's `playbook-verification.test.ts`). This is not a spec bug; it is a consequence of the division of labour fixed in the spec header.

## Matrix summary

| FR | Healthy | Phase A revert | Phase B revert | Phase C revert |
|----|---------|---------------|----------------|----------------|
| FR-002 | ✅ pass | ✅ pass (still distinct ids by derivation) | ❌ fail (attributable) | ❌ fail (shares Phase B) |
| FR-003 | ✅ pass | ❌ fail (attributable) | ❌ fail (attributable) | ❌ fail (shares Phase B) |
| FR-004 | ✅ pass | ✅ pass (dedup at MCP boundary independent of runId) | ✅ pass (dedup still holds within a run) | ✅ pass |
| FR-005 | ✅ pass | ❌ fail (attributable) | ✅ pass | ✅ pass |
| FR-006 | ✅ pass | ✅ pass (orthogonal to runId) | ✅ pass | ✅ pass |
| FR-007 | ✅ pass | ✅ pass | ✅ pass | ✅ pass |
| FR-008 | ✅ pass | ✅ pass | ✅ pass (this IS Phase B revert direction — passes trivially) | ✅ pass |
| FR-009 | ✅ pass | ✅ pass (this IS Phase A revert direction — passes trivially) | ✅ pass | ✅ pass |

Every reverted phase reddens at least one FR test with an attributable name (`FR-XXX (Phase Y reverted): <specific failure>`). Coverage per SC-002: 7/7 items pinnable with per-phase attribution modulo the Phase B / Phase C indistinguishability noted above.

## CI matrix realization

Vitest's `describe.each` runs the four cells:

```ts
describe.each([
  { label: 'healthy',   opts: {} },
  { label: 'phase-A-reverted', opts: { fakeCloudOptions: { persistGeneration: false } } },
  { label: 'phase-B-reverted', opts: { omitRunId: true } },
  // phase-C-reverted omitted — assertion-identical to phase-B, would be duplicate CI cost.
])('SC-002 revert matrix: $label', ({ opts }) => {
  // ... 7 FR test bodies, each toggling assertions on `opts` ...
});
```

Rationale for omitting Phase C from the matrix cell list: assertion-identical to Phase B (per matrix table). Documented in the test file header. Phase C attribution lives in `contracts/revert-scenarios.md` (this file) and is verifiable at review time by tracing the FR-002 / FR-003 failures back to "MCP tool called without runId" regardless of which layer stripped it.

## What SC-002 explicitly does NOT require

- Full production revert of any phase (that would require rebuilding cluster/cloud/agency at old commit-shas — out of scope, ties into the source-linked deployment note in Assumption §6).
- CI running against a real reverted-phase deployment.
- Bisection or automatic attribution — the mapping FR → phase is manual and lives in this file.
