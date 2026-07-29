# Feature Specification: End-to-end verification of run-scoped gate identity across generacy / generacy-cloud / agency

**Branch**: `1068-problem-gate-identity-work` | **Date**: 2026-07-29 | **Status**: Draft
**Source issue**: [generacy#1068](https://github.com/generacy-ai/generacy/issues/1068)
**Depends on**: generacy-cloud Phase A, generacy Phase B, agency Phase C (all three must land before this can run)

## Summary

The run-scoped gate identity work spans three repos. Every individual phase is designed to be a no-op until the last one lands — which is what makes the sequence safe, and also what makes it unverifiable from inside any single repo. Each repo's CI can be fully green while the composed path is silently broken.

This issue is the end-to-end verification that runs after the last phase deploys. It exercises the real WebSocket path with a real cluster against a real cloud instance and asserts seven properties that collectively pin the composed contract.

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

**Acceptance Criteria**:
- [ ] Across ≥3 wakes of a single run that hold on the same gate, the drafting subagent is spawned exactly once.

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

**Acceptance Criteria**:
- [ ] A cluster build without Phase B (no `runId` sent) can open a gate, answer it, and reach `applied` against Phase-A cloud.
- [ ] A pre-Phase-A gate doc (no `generation` field) still surfaces via `cockpit_gate_list` through the fallback code path.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Test harness must exercise the real WebSocket relay path — no `vi.fn()` peer, no `MockRelayClient`. | P1 | US5. Pattern: `packages/cluster-relay/tests/relay.test.ts` + `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts` (established WebSocketServer harness). |
| FR-002 | Assert re-running an `applied` phase in the same `runId` opens a new gate. | P1 | US1. Whole point of the epic. |
| FR-003 | Assert `cockpit_gate_status(runId=<current>)` returns `open` immediately after gate open, not `absent`. | P1 | US2. Silent `absent` violates `auto.md:283`. |
| FR-004 | Assert the drafting subagent runs exactly once across N≥3 wakes on the same gate. | P1 | US3. Requires observable emit count from the drafting path. |
| FR-005 | Assert `cockpit_gate_list` renders `generation` without `runId` suffix for both simple (`P2`) and colon-bearing (`artifact-review:spec-review:<sha>`) generations. | P2 | US4. Rendering is the assertion; internal storage may include `runId`. |
| FR-006 | Assert `frameId` on a reply matches the `frameId` the cluster emitted, captured over a real socket. | P1 | US5. Load-bearing — this is the specific gap that shipped inert. |
| FR-007 | Assert zero `Invalid relay message, skipping` lines in cluster stdout during a successful gate ingest cycle. | P2 | US6. Regression guard for generacy#1063. |
| FR-008 | Assert a cluster that omits `runId` still completes a gate cycle against Phase-A cloud (backward compat direction 1). | P1 | US7. |
| FR-009 | Assert a gate doc with no `generation` field lists via the pre-Phase-A fallback (backward compat direction 2). | P1 | US7. |
| FR-010 | Test must fail closed on any of FR-002 through FR-009, with each failure attributable to the specific verification item that broke. | P1 | Prevents "one failure hides the rest" degeneration. |
| FR-011 | Test must run against a cluster on the new build with workers restarted (not just the orchestrator). | P1 | Precondition — avoids version-skew false positives from stale worker npm packages. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | End-to-end test passes on a cluster with all three phases deployed. | Pass on 3 consecutive runs. | Run the test 3× on a fresh cluster; all pass. |
| SC-002 | Each of the seven verification items maps to at least one failing test assertion when the corresponding phase is reverted. | 7/7 verification items pinnable. | Reviewer reverts each phase in isolation; harness produces at least one attributable failure for the reverted phase. |
| SC-003 | Zero `Invalid relay message, skipping` in cluster stdout during a successful cycle. | 0 occurrences. | Grep cluster log output post-cycle. |
| SC-004 | Draft-once assertion holds across ≥3 wakes. | 1 draft spawn per gate. | Instrumented count on the drafting subagent invocation. |
| SC-005 | Backward-compat scenarios (no-`runId` cluster + no-`generation` doc) both pass. | 2/2 scenarios pass. | Run both compat tests; both pass. |
| SC-006 | Test runtime budget in CI. | ≤ 90 s median, ≤ 180 s p95. | CI job timings, aligned with sibling `relay-integration.integration.test.ts` (~15–25 s local baseline). |

## Assumptions

1. All three phases (Phase A cloud, Phase B generacy, Phase C agency) have landed on their target channels before this issue is worked. If any phase is missing, this issue blocks — it is not a substitute for the phase work.
2. `frameId` correlation over a real WebSocket peer is the load-bearing part of FR-006 — echo-mocks are worthless here (that is precisely why the bug shipped).
3. Structured logs / instrumented emit counts are the observation surface for FR-004 and FR-007. If either surface is missing, this issue must add it as part of the harness rather than substitute a weaker signal.
4. Test harness sits in `packages/orchestrator/src/__tests__/` alongside the existing `relay-integration.integration.test.ts` — a proven pattern for cross-process integration tests in this repo.
5. Workers must be restarted after the cluster update. `generacy update` refreshes image digests but does not re-pull `@channel` npm packages; the orchestrator entrypoint does on restart, but worker processes need their own restart.

## Out of Scope

- Implementation of Phase A / Phase B / Phase C themselves — this issue verifies their composition, not their internals.
- Fixing individual phase bugs discovered during verification — those are follow-up issues raised against the owning repo.
- Cross-cluster / multi-tenant scenarios — single-cluster end-to-end path only.
- Load or performance testing of the gate identity path.
- UI-side rendering of the inbox beyond the `cockpit_gate_list` MCP tool output.
- Generalization of the harness into a reusable multi-repo test framework.

## Provenance

Split from generacy#1059, whose acceptance criteria are all end-to-end and therefore land here. Depends on the generacy-cloud Phase A, generacy Phase B, and agency Phase C issues.

---

*Generated by speckit*
