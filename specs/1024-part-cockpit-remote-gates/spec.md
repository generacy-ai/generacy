# Feature Specification: Cockpit gates — cluster-side end-to-end integration test

**Branch**: `1024-part-cockpit-remote-gates` | **Date**: 2026-07-21 | **Status**: Draft

## Summary

Part of the **Cockpit Remote Gates** epic — a central operator inbox on generacy.ai for answering `/cockpit:auto` human gates so the driving session never blocks. Epic tracking issue: generacy-ai/generacy-cloud (see epic for phase ordering). Full design and **wire contracts** (gate record, answer NDJSON line, outcome ack, gateId/generation rules): [cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md). Implement against the contracts as written; propose contract changes on the epic before diverging.

## Context

P1 integration issue: prove the whole cluster-side path with no cloud, using a simulated relay peer, and close any seams between the P1 issues (contracts module, orchestrator routes + `cluster.cockpit` relay channel + answers-file writer, MCP `cockpit_gate_open`/`cockpit_gate_ack` tools, doorbell answers-file tail + `cockpit_await_events` feed).

This issue is the last item in P1. It does not add product surface on its own; it produces a runnable harness that proves the four preceding P1 issues compose correctly and pins the wire shapes that P2 (cloud) will mirror on the other side.

## Scope

An integration test harness (fake relay peer + orchestrator + doorbell + MCP bus) covering:

1. Gate open via `POST /cockpit/gates` → `cluster.cockpit` relay event observed by the fake peer (including retain-and-replay across a simulated disconnect).
2. Answer injected by the fake peer as `api_request POST /cockpit/answers` → answers-file line → doorbell stdout `gate-answer` event **and** `cockpit_await_events` typed batch.
3. Ack via `POST /cockpit/gates/:id/ack` → outcome relay event observed.
4. Restart replay: doorbell restarted mid-flow re-emits unacked answers exactly once.
5. `deliveryId` dedup end-to-end.

Fix any integration gaps discovered in the P1 issues as part of this issue.

## Acceptance criteria

- Harness runs green in CI using the shared contract fixtures from the gates module.
- Documented invocation so the cloud-side fake-cluster tests (P2) can mirror the same message shapes.

## User Stories

### US1: Cluster-side path is provably wired

**As a** cockpit contributor landing a P1 sibling issue (contracts, routes, MCP tool, or doorbell),
**I want** an integration harness that exercises the whole cluster-side flow with a fake relay peer,
**So that** I can catch inter-issue seams (schema drift, channel-name mismatch, missing dedup, doorbell tail race) before the cloud lands and only see failures from my own code.

**Acceptance Criteria**:
- [ ] Landing any of the P1 sibling PRs re-runs this harness in CI and fails loudly when the wire shape or dispatch order drifts.
- [ ] A defect in any single P1 sibling produces a harness failure attributable to that seam (not a generic timeout).

### US2: Cloud can mirror the same shapes

**As a** engineer implementing the P2 cloud side (`generacy-ai/generacy-cloud` — relay ingest, respond endpoint, redelivery on reconnect),
**I want** the harness contracts and fixtures published in a form I can import,
**So that** the cloud-side fake-cluster tests emit and expect the exact same bytes as the real cluster does — pinning the boundary once, in one place.

**Acceptance Criteria**:
- [ ] The gates module (`packages/cockpit/src/gates/`) exports fixture builders (gate record, answer line, outcome ack) that this harness consumes; the P2 issue can import them without cross-repo copy-paste.
- [ ] The harness README documents the exact relay message shapes exchanged with the fake peer, keyed by contract name, so P2 can assert against the same shapes.

### US3: Restart and takeover behavior is verified end-to-end

**As a** operator whose session or cluster restarts mid-flow,
**I want** an unacked answer that was written to the answers file before the crash to be replayed exactly once on restart — not lost, not double-applied,
**So that** operator answers submitted from the UI don't silently disappear when a session recycles.

**Acceptance Criteria**:
- [ ] Restarting the doorbell mid-flow with unacked answers in the file replays them once — the harness observes exactly one stdout `gate-answer` event and one `cockpit_await_events` entry per unacked answer.
- [ ] Re-injecting the same answer with the same `deliveryId` after replay is deduped — the harness observes zero additional events.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The harness stands up the orchestrator gate routes, the doorbell subprocess, and the cockpit MCP event-bus registry in-process (or as child processes) with no cloud dependency and no live GitHub. | P1 | The four P1 siblings are the units under test; nothing else. |
| FR-002 | The harness includes a fake relay peer that speaks the relay `event` / `api_request` / `api_response` message frames on the same WebSocket the real cloud would use. | P1 | Reuses the existing `cluster-relay` server-side framing; no new wire protocol. |
| FR-003 | Scenario 1 (gate open): posting a valid gate record to `POST /cockpit/gates` produces exactly one `cluster.cockpit` event on the fake peer's inbound stream, with a payload byte-equal to the contract's `gate-open` shape. | P1 | Contract shape from the gates module. |
| FR-004 | Scenario 1 (retain-and-replay): if the fake peer is disconnected when the gate is opened and reconnects, the same `cluster.cockpit` event is delivered on reconnect. | P1 | Mirrors `cluster.vscode-tunnel` retention pattern. |
| FR-005 | Scenario 2 (answer down-path): the fake peer sending `api_request POST /cockpit/answers` with a valid answer body causes the orchestrator to (a) append one NDJSON line to the answers file, (b) return a 2xx response, (c) surface a `gate-answer` stdout line from the doorbell, and (d) return a `gate-answer` batch entry from `cockpit_await_events`. | P1 | All four side-effects observed in a single scenario. |
| FR-006 | Scenario 3 (ack): posting an outcome to `POST /cockpit/gates/:id/ack` produces exactly one `cluster.cockpit` outcome event on the fake peer, with a payload byte-equal to the contract's outcome-ack shape. | P1 | |
| FR-007 | Scenario 4 (restart replay): killing and restarting the doorbell while an answer is in the answers file but no ack has been issued causes the doorbell to re-emit the `gate-answer` line exactly once and the MCP event-bus to re-surface it exactly once. | P1 | Position persistence granularity is decided in `/clarify` — see [NEEDS-CLARIFICATION-1]. |
| FR-008 | Scenario 5 (`deliveryId` dedup): injecting the same answer line twice (same `deliveryId`, distinct request IDs) causes the second injection to be deduped — one file line, one doorbell stdout event, one `cockpit_await_events` batch entry across both injections. | P1 | The dedup layer under test is decided in `/clarify` — see [NEEDS-CLARIFICATION-2]. |
| FR-009 | The harness's assertions consume the contract fixtures exported by `packages/cockpit/src/gates/` — no duplicated schema literals in the test file. | P1 | Prevents drift between the contracts issue and this harness. |
| FR-010 | The harness runs green in CI on the same runners as the rest of the workspace's `pnpm test`, without network egress and without dependence on a live smee channel. | P1 | Fake peer replaces both cloud and smee. |
| FR-011 | The harness's invocation and the message shapes it exchanges are documented in the repo (spec directory or the gates module README), with enough detail for the P2 cloud-side fake-cluster tests to mirror the same message shapes. | P1 | Per acceptance criterion in the issue. |
| FR-012 | Any integration seam discovered while writing the harness that requires a change in a P1 sibling issue is fixed inside this issue's PR (not deferred). | P1 | Per issue text: "Fix any integration gaps discovered in the P1 issues as part of this issue." |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Harness runs green in CI | 100 % on `develop` after this PR merges | `pnpm test` in CI shows the harness suite passing on every `develop` push. |
| SC-002 | Each of the five scenarios in Scope is covered by at least one assertion | 5 / 5 scenarios asserted | Test file inventory maps 1:1 to the scope list. |
| SC-003 | The five scenarios detect regressions in each P1 sibling | For each of the four sibling issues (contracts, routes, MCP tool, doorbell), a deliberate 1-line breakage produces at least one failing scenario | Verified during PR review (attach failure output for each induced break in the PR description). |
| SC-004 | Wire shapes are single-sourced | Zero literal schema shapes duplicated between the harness and the gates module | `grep`-based check on the harness file: it imports fixture builders, no inline shape literals. |
| SC-005 | Harness invocation is documented | P2 (cloud) engineer can reproduce the same message shapes from the README without asking questions | Verified when the P2 fake-cluster harness lands and references this README. |
| SC-006 | Harness runtime is bounded | Median CI run under 30 s; p95 under 90 s | CI job duration. |

## Assumptions

- The gates contracts module (P1 sibling 1) exports Zod schemas and fixture builders that this harness can import directly. If it doesn't (or the contracts issue lands after this one), this issue extends that module — it does not duplicate the shapes.
- The fake relay peer can be built as a thin `ws`-based server that speaks the same `RelayMessageSchema` union the real cloud speaks; no changes to `packages/cluster-relay` framing are needed.
- The orchestrator, doorbell, and MCP event-bus can each be booted in-process or as child processes under a Vitest driver without pulling in Docker or Firebase emulators.
- The answers file location is `/workspaces/.generacy/cockpit/answers.ndjson` per the epic plan; the harness redirects this to a per-test temp directory via an env var (introduced in the routes sibling if not already present).
- Retain-and-replay for `cluster.cockpit` mirrors the `cluster.vscode-tunnel` retention pattern already in the orchestrator; the harness asserts observed behavior, not the retention implementation.
- CI runs against `pnpm test` on Node ≥22 (per repo constitution).

## Open questions — resolve in `/clarify`

- **[NEEDS-CLARIFICATION-1]** Restart-replay position persistence: is the doorbell's answers-file read position persisted (a) on disk between restarts, (b) recomputed from unacked state on start, or (c) always re-read from head with dedup as the guard? The choice changes what "replay exactly once" means in FR-007 and where the assertion hooks belong.
- **[NEEDS-CLARIFICATION-2]** `deliveryId` dedup owner: is dedup performed by the orchestrator's answers-file writer (dedup before write), by the doorbell (dedup before emit), or by both layers with the answers file as the audit record? FR-008's assertion surface depends on which layer holds the dedup state.
- **[NEEDS-CLARIFICATION-3]** Harness process model: are the orchestrator + doorbell + MCP bus booted in-process against Vitest, or as child processes with IPC? In-process is faster and easier to assert against; child processes prove the real spawn/exit lifecycle. The scope allows either; pick one before `/plan`.
- **[NEEDS-CLARIFICATION-4]** Failure-mode coverage: does this harness assert only the happy paths listed in Scope, or does it also cover documented failure modes (malformed answer line skipped-and-logged, orchestrator 4xx on invalid gate open, doorbell tolerating file rotation)? The issue text lists only the five happy-path scenarios; adding failure-mode assertions is defensible for closing P1 seams but expands scope.

## Out of Scope

- Any cloud-side code (Firestore collection, respond endpoint, SSE stream, UI, redelivery-on-reconnect) — that is P2 in the epic (issues 6–9).
- The `--gates=ui` skill rework in `agency/` — that is P4 in the epic (issues 14–15).
- Real GitHub App / installation-token calls, real smee.io channels, live cloud API — the harness runs against fakes only.
- Contract redesign: this issue implements against the contracts as written in the epic plan; contract changes are proposed on the epic before diverging.
- Load, soak, or fuzz testing — this is an integration harness, not a stress test.
- Web push, notification UX, dual-surface gates — deferred by the epic itself.

---

*Generated by speckit*
