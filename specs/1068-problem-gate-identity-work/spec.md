# Feature Specification: End-to-end verification of run-scoped gate identity across generacy / generacy-cloud / agency

**Branch**: `1068-problem-gate-identity-work` | **Date**: 2026-07-29 | **Status**: Draft
**Source issue**: [generacy#1068](https://github.com/generacy-ai/generacy/issues/1068)
**Depends on**: generacy-cloud Phase A, generacy Phase B, agency Phase C (all three must land before this can run)

## Summary

The run-scoped gate identity work spans three repos. Every individual phase is designed to be a no-op until the last one lands — which is what makes the sequence safe, and also what makes it unverifiable from inside any single repo. Each repo's CI can be fully green while the composed path is silently broken.

This issue is the end-to-end verification that runs after the last phase deploys. It exercises **a real cluster over a real WebSocket against a schema-validated cloud fake** and asserts seven properties that collectively pin the composed contract (see §Clarifications Q1). Cluster↔cloud semantic divergence is NOT detectable by this harness and remains covered only by generacy-cloud's own suite. The harness extends the `WebSocketServer`-based pattern established in `packages/orchestrator/src/__tests__/cockpit-gates/fake-peer.ts` (#1024) and extended in #1077.

### Division of labour with agency (fixed here, not negotiable at plan time)

- **This repo (generacy)**: pins the MCP tool behaviour — `cockpit_gate_open`, `cockpit_gate_status`, `cockpit_gate_list`, `cockpit_gate_ack`, and the pre-draft dedup invariant they collectively guarantee.
- **agency (`packages/claude-plugin-cockpit/tests/playbook-verification.test.ts`)**: pins that `auto.md` consumes those tools correctly (186 assertions as of agency#471, including `471-12` on the same-generation branch across all six Step-0 blocks).

Neither repo can make both claims. This harness deliberately does not spawn a real `claude` process or the drafting subagent — see §Clarifications Q2.

## Failure Mode This Exists to Catch

The composed path fails silently in both directions:

- The cluster receives a `202` from `POST /internal/relay-events`.
- The cloud logs a `console.warn('Invalid relay message, skipping')` and drops the frame.
- The operator sees an auto session insisting a gate needs an answer while the inbox shows zero open gates.
- Nothing in either repo's CI notices, because the schema mismatch straddles the process boundary and no single repo's test suite crosses it.

## Preconditions

- generacy-cloud Phase A deployed: gate doc stores `generation`; `deriveGateKey` accepts optional `runId` on write **and** read paths.
- generacy Phase B released and the cluster running it: optional `runId` threaded through `cockpit_gate_status` / `cockpit_gate_list` inputs and the query client.
- agency Phase C released: `/cockpit:auto` passes a `runId`.
- A cluster on the new build. `generacy update` is image-digest-based and does **not** re-pull `@channel` npm packages — a restart re-runs the orchestrator entrypoint and does. Restart workers too, or you get version skew; new packages need a fresh Claude session.

## User Stories

### US1 (P1): Re-running a phase produces a new gate

**As an** operator driving an epic through `/cockpit:auto`,
**I want** re-running a completed phase to open a new gate in the inbox,
**So that** the round-trip works and the operator sees they need to answer again — instead of the auto session insisting a gate needs an answer while the inbox shows nothing to answer.

**Acceptance Criteria**:
- [ ] Run an epic phase through to a gate, answer it, let the outcome reach `applied`.
- [ ] Re-run the same phase in the same run.
- [ ] A new open gate appears in the inbox (not a resurrection of the applied gate; not silently absent).

### US2 (P1): `cockpit_gate_status` and the inbox agree in-run

**As an** auto session that just opened a gate,
**I want** `cockpit_gate_status` to return `open` for a gate opened in the same run,
**So that** the pre-draft dedup invariant at `auto.md:283` holds and I do not re-draft a gate that already exists.

**Acceptance Criteria**:
- [ ] Immediately after opening a gate, `cockpit_gate_status(runId=<current>)` returns `open`, not `absent`.
- [ ] The status call and the inbox listing return the same gate identity (same `frameId` / same key).

### US3 (P1): No duplicate drafting across wakes of one run

**As an** operator watching auto burn tokens,
**I want** the drafting subagent to run once per gate, not once per wake,
**So that** a slow gate does not cause redraft-per-wake amplification.

**Acceptance Criteria** (re-scoped by §Clarifications Q2, Q4 — asserts the pre-draft dedup invariant at the MCP boundary, which is what the drafting single-spawn behaviour actually protects; assertion is stronger than a subagent spawn count because it measures what reaches the operator's inbox):
- [ ] Across ≥3 wakes of a single run that hold on the same natural gate, `cockpit_gate_status(runId=<current>)` returns `open` or `answered` on wakes 2..N (never `absent`).
- [ ] Exactly one `cockpit_gate_open` reaches the peer for that gate across the same wake sequence.
- [ ] Exactly one `'cockpit gate emitted'` log line is emitted per `gateId` (from `packages/orchestrator/src/routes/cockpit-gates.ts` in `tryEmitOrRetain`).
- [ ] The peer receives exactly one `cluster.cockpit` frame for that `gateId` (post-#1077 each frame carries a distinct `frameId`; two frames = two ids = duplicate emit).

### US4 (P2): `generation` renders without leaking `runId`

**As an** operator reading `cockpit_gate_list` output,
**I want** the generation column to show the human generation (`P2`, `artifact-review:spec-review:<sha>`),
**So that** UI does not display `P2:<runId>` and the value stays parseable when the generation itself contains colons.

**Acceptance Criteria**:
- [ ] `cockpit_gate_list` shows `P2` for a `P2` gate, not `P2:<runId>`.
- [ ] For `artifact-review:spec-review:<sha>` (contains `:`), the rendered generation matches the full string, unaltered.

### US5 (P1): `frameId` correlation asserted over a real WebSocket

**As a** contract reviewer,
**I want** the reply's `frameId` matched against the frame the cluster actually sent over a live socket,
**So that** the correlation is not an artifact of a `vi.fn()` that echoes its own argument — which is why the correlation shipped inert in the first place.

**Acceptance Criteria**:
- [ ] Test opens a real `ws://` connection (not a mock).
- [ ] Cluster-emitted `frameId` matches the `frameId` on the corresponding reply, byte-for-byte.

### US6 (P2): No misleading WARN on successful ingest

**As an** operator reading cluster logs,
**I want** a successful gate ingest to produce zero `Invalid relay message, skipping` lines,
**So that** the previously misleading log (fixed in generacy#1063) does not resurface.

**Acceptance Criteria**:
- [ ] Cluster stdout during a successful `open` → `applied` cycle contains zero `Invalid relay message, skipping` occurrences.

### US7 (P1): Backward compatibility with `runId`-less clusters and pre-Phase-A docs

**As an** operator on a mixed-version deployment,
**I want** a cluster that omits `runId` to still work against the new cloud,
**And** gate docs written before Phase A to still list correctly via the fallback,
**So that** the rollout is safely resumable and old data remains readable.

**Acceptance Criteria** (realization detail fixed by §Clarifications Q3 — hybrid: FR-008 uses omission of the optional field, FR-009 uses direct-write to the fake's store):
- [ ] A cluster build without Phase B — realized by **omitting the optional `runId` field** on `cockpit_gate_open` / `cockpit_gate_ack` / `cockpit_gate_status` / `cockpit_gate_list` (no simulation flag; `runId` is already `z.string().min(1).optional()` on every gate schema) — can open a gate, answer it, and reach `applied` against Phase-A cloud.
- [ ] A pre-Phase-A gate doc — realized by **hand-crafting a doc without the `generation` field directly into the fake cloud's store** — still surfaces via `cockpit_gate_list` through the fallback code path.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Test harness must exercise the real WebSocket relay path — no `vi.fn()` peer, no `MockRelayClient`. | P1 | US5. Pattern: `packages/cluster-relay/tests/relay.test.ts` + `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts` (established WebSocketServer harness). Under §Clarifications Q1: extends `packages/orchestrator/src/__tests__/cockpit-gates/fake-peer.ts` (already a real `WebSocketServer` from #1024/#1077). |
| FR-002 | Assert re-running an `applied` phase in the same `runId` opens a new gate. | P1 | US1. Whole point of the epic. |
| FR-003 | Assert `cockpit_gate_status(runId=<current>)` returns `open` immediately after gate open, not `absent`. | P1 | US2. Silent `absent` violates `auto.md:283`. |
| FR-004 | Assert the pre-draft dedup invariant at the MCP boundary across N≥3 wakes on the same natural gate: `cockpit_gate_status` returns `open`/`answered` on wakes 2..N (never `absent`); exactly one `cockpit_gate_open` reaches the peer; exactly one `'cockpit gate emitted'` log line per `gateId`; exactly one `cluster.cockpit` frame per `gateId` on the wire (distinguishable by distinct `frameId` per #1077). | P1 | US3. Re-scoped from "drafting subagent runs exactly once" per §Clarifications Q2, Q4 — the drafting subagent lives in `auto.md` playbook prose, not code; asserting the invariant it protects at the MCP boundary is both feasible and stronger. Observable via existing `packages/orchestrator/src/routes/cockpit-gates.ts` `tryEmitOrRetain` log line + peer-side frame count. |
| FR-005 | Assert `cockpit_gate_list` renders `generation` without `runId` suffix for both simple (`P2`) and colon-bearing (`artifact-review:spec-review:<sha>`) generations. | P2 | US4. Rendering is the assertion; internal storage may include `runId`. |
| FR-006 | Assert `frameId` on a reply matches the `frameId` the cluster emitted, captured over a real socket. Fake peer MUST validate inbound `cluster.cockpit` frame payloads with `GateOpenWireSchema` / `GateOutcomeWireSchema` from generacy `mcp/gates/schemas.ts` (not read fields ad hoc), so a cluster-side shape change fails locally instead of silently diverging. | P1 | US5. Load-bearing — this is the specific gap that shipped inert. `frameId` is opaque and read off raw frame data by the real cloud (`generacy-cloud/services/api/src/services/relay/message-handler.ts:812`); the fake must be equally strict about payload shape. |
| FR-007 | Assert zero `Invalid relay message, skipping` lines in cluster stdout during a successful gate ingest cycle. | P2 | US6. Regression guard for generacy#1063. |
| FR-008 | Assert a cluster that **omits the optional `runId` field** on all four gate tool calls still completes a gate cycle against Phase-A cloud (backward compat direction 1). Realization is not-passing an optional field — NOT a `SIMULATE_PHASE_B_MISSING` flag, and not a pinned old-tarball install (the deployed cluster is source-linked). | P1 | US7. §Clarifications Q3, Q5. |
| FR-009 | Assert a gate doc with no `generation` field, **hand-crafted directly into the fake cloud's store**, lists via the pre-Phase-A fallback (backward compat direction 2). | P1 | US7. §Clarifications Q3. |
| FR-010 | Test must fail closed on any of FR-002 through FR-009, with each failure attributable to the specific verification item that broke. | P1 | Prevents "one failure hides the rest" degeneration. |
| FR-011 | Test must run against a cluster on the new build with workers restarted (not just the orchestrator). | P1 | Precondition — avoids version-skew false positives from stale worker npm packages. |
| FR-012 | Fault-injection knobs used by SC-002 MUST live in harness/fixture code only. No `SIMULATE_PHASE_*` environment variable, config flag, or code branch may exist in a shipped production code path (orchestrator, control-plane, cluster-relay, MCP server). If any of the seven verification items is un-revertable without touching production code, that item drops to manual attribution (option A of §Clarifications Q5) and is explicitly named in the spec — the production knob is not the escape hatch. | P1 | §Clarifications Q5. A production binary carrying env-var-triggered "behave like the broken version" branches is one misconfiguration away from being the broken version in a real cluster and inverts the meaning of every log line around it. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | End-to-end test passes on a cluster with all three phases deployed. | Pass on 3 consecutive runs. | Run the test 3× on a fresh cluster; all pass. |
| SC-002 | Each of the seven verification items maps to at least one failing test assertion when the corresponding phase is reverted, with **attribution** (the failing assertion names the reverted phase's specific behaviour), not just failure. A revert that reddens the whole suite proves coupling, not attribution. Exercised via fault-injection knobs in **harness/fixture code only** (§Clarifications Q5) — under §Clarifications Q1=A most knobs are fake-side config: *Phase A reverted* → fake's store does not persist `generation`; *Phase B reverted* → harness omits `runId` on send (not-a-flag per §Clarifications Q3); *Phase C reverted* → harness does not pass `runId` on open/ack. CI runs healthy + N revert scenarios. | 7/7 verification items pinnable **with per-phase attribution**. | CI runs a healthy matrix cell and one revert cell per phase; each revert cell fails on the assertion matching the reverted phase's behaviour. Any item that cannot be exercised without a production-code knob is dropped to manual attribution and explicitly named in the spec (per FR-012). |
| SC-003 | Zero `Invalid relay message, skipping` in cluster stdout during a successful cycle. | 0 occurrences. | Grep cluster log output post-cycle. |
| SC-004 | Draft-once assertion holds across ≥3 wakes. | 1 draft spawn per gate. | Instrumented count on the drafting subagent invocation. |
| SC-005 | Backward-compat scenarios (no-`runId` cluster + no-`generation` doc) both pass. | 2/2 scenarios pass. | Run both compat tests; both pass. |
| SC-006 | Test runtime budget in CI. | ≤ 90 s median, ≤ 180 s p95. | CI job timings, aligned with sibling `relay-integration.integration.test.ts` (~15–25 s local baseline). |

## Assumptions

1. All three phases (Phase A cloud, Phase B generacy, Phase C agency) have landed on their target channels before this issue is worked. If any phase is missing, this issue blocks — it is not a substitute for the phase work.
2. `frameId` correlation over a real WebSocket peer is the load-bearing part of FR-006 — echo-mocks are worthless here (that is precisely why the bug shipped).
3. Observation surfaces for FR-004 and FR-007 already exist and are used as-is:
   - FR-004 uses the existing `'cockpit gate emitted'` log line in `packages/orchestrator/src/routes/cockpit-gates.ts` `tryEmitOrRetain` (structured `{ gateId, type }`) plus peer-side `cluster.cockpit` frame count. This is a **stronger** signal than a drafting-subagent spawn count (one layer closer to the operator) — the assumption is that substituting to a stronger observable, not adding a redundant one, satisfies the "no weaker signal" constraint (§Clarifications Q4).
   - FR-007 uses cluster stdout grep for the exact `Invalid relay message, skipping` string — the regression-target text from generacy#1063.
4. Test harness sits in `packages/orchestrator/src/__tests__/cockpit-gates/` and extends `fake-peer.ts` + `cockpit-gates-integration.integration.test.ts` (established by #1024, extended by #1077) rather than creating a parallel harness. The fake peer must be tightened to validate `cluster.cockpit` frame payloads with the frozen wire schemas (`GateOpenWireSchema` / `GateOutcomeWireSchema` from generacy `mcp/gates/schemas.ts`) rather than only the envelope (`RelayMessageSchema`), so that a cluster-side payload-shape change fails locally.
5. Workers must be restarted after the cluster update. `generacy update` refreshes image digests but does not re-pull `@channel` npm packages; the orchestrator entrypoint does on restart, but worker processes need their own restart.
6. Cluster-side code is source-linked in this deployment (`generacy` CLI resolves to `/workspaces/generacy/packages/generacy/bin/generacy.js`, running the mounted source tree). Published npm versions are not the distribution mechanism, so version-skew tests cannot be realized by pinning old tarballs — the honest realizations are omitting optional fields on the wire (FR-008) and hand-writing pre-migration docs directly into the fake's store (FR-009). See §Clarifications Q3.
7. `runId` is optional on every gate MCP schema (`CockpitGateStatusInputSchema`, `CockpitGateListInputSchema`, `GateOpenInputSchema`, `GateAckInputSchema` all declare `runId: z.string().min(1).optional()`). FR-008's "old cluster" realization is field omission on the harness's tool calls — not a config flag, and never a production-side switch (per FR-012).

## Out of Scope

- Implementation of Phase A / Phase B / Phase C themselves — this issue verifies their composition, not their internals.
- Fixing individual phase bugs discovered during verification — those are follow-up issues raised against the owning repo.
- Cross-cluster / multi-tenant scenarios — single-cluster end-to-end path only.
- Load or performance testing of the gate identity path.
- UI-side rendering of the inbox beyond the `cockpit_gate_list` MCP tool output.
- Generalization of the harness into a reusable multi-repo test framework.

## Provenance

Split from generacy#1059, whose acceptance criteria are all end-to-end and therefore land here. Depends on the generacy-cloud Phase A, generacy Phase B, and agency Phase C issues.

## Clarifications

Detailed rationale for each answer lives in `clarifications.md`. Load-bearing decisions summarized here:

- **Q1 → A**: Fake WS peer + fake HTTP cloud, extending `fake-peer.ts` (#1024/#1077). Payload validation via wire schemas is required (see FR-006). Staging cloud (option C) rejected outright — it shares the production Firestore.
- **Q2 → C**: MCP tool-call driver. Option A (direct call to drafting entry-point) struck as unimplementable — the drafting subagent is `auto.md` playbook prose, not code. FR-004 re-scoped to pin the dedup invariant at the MCP boundary.
- **Q3 → C (hybrid)**: FR-008 = omit optional `runId` field (no flag). FR-009 = hand-crafted pre-Phase-A doc written directly into the fake's store.
- **Q4 → C**: Existing `'cockpit gate emitted'` log line + wire-level frame count are the observability surface. Stronger than a drafting-spawn count because it measures what reaches the operator's inbox.
- **Q5 → B**: Fault-injection knobs in harness/fixture code only. FR-012 forbids `SIMULATE_PHASE_*` switches in shipped code. Items that cannot be exercised without a production knob drop to manual attribution and are named in the spec.

---

*Generated by speckit*
