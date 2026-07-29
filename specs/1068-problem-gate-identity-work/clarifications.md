# Clarifications

**Feature**: End-to-end verification of run-scoped gate identity across generacy / generacy-cloud / agency
**Issue**: [generacy#1068](https://github.com/generacy-ai/generacy/issues/1068)

---

## Batch 1 — 2026-07-29

### Q1: Cloud target
**Context**: Spec calls for "a real cluster against a real cloud instance" but caps CI runtime at 90 s median / 180 s p95 (SC-006) and points at `relay-integration.integration.test.ts` (a `WebSocketServer`-based in-process peer) as the pattern. These two directions pull opposite ways and load-bear on almost every other decision in the harness (Q2, Q3, Q5). Assumption 4 says the harness sits in `packages/orchestrator/src/__tests__/`, which favours in-process — but that repo can't stand up real cloud services on its own.
**Question**: How does the harness obtain the cloud side of the path?
**Options**:
- A: **Fake WS peer + fake HTTP cloud** — in-process `WebSocketServer` plus a minimal HTTP handler emulating the gate-doc / `generation` storage. Matches the sibling #1024 harness pattern. Fits the SC-006 budget. Trade-off: the "real cloud" phrase in the spec is softened to "real WebSocket wire path against a shape-compatible cloud fake".
- B: **Ephemeral real cloud in CI** — CI spins up a real `generacy-cloud` container (Next.js + Firestore emulator) per run. Highest fidelity. Materially heavier CI infra; runtime likely >90 s.
- C: **Shared staging cloud** — harness targets a persistent staging env with a scoped project. Fastest to build; flaky under concurrent CI runs; leaks state across runs.

**Answer**: *Pending*

---

### Q2: `/cockpit:auto` invocation surface
**Context**: FR-004 requires an assertion that the drafting subagent runs exactly once across ≥3 wakes. The observable count has to come from somewhere; the spec is silent on which layer emits it and whether `/cockpit:auto` runs as a real `claude` process. This choice determines almost every other test-file shape.
**Question**: How does the harness drive `/cockpit:auto` and count drafting-subagent spawns?
**Options**:
- A: **Direct call to drafting entry-point** — skip `claude` entirely. Test imports the drafting JS entry-point (agency's `plugin-cockpit` package) and invokes it directly with a `vi.spyOn` for the count. Deterministic, fastest, but bypasses the real `/cockpit:auto` prompt loop.
- B: **Real `claude` CLI subprocess** — spawn a real `claude` process running the `/cockpit:auto` skill. Highest realism. Requires a stubbed LLM backend (SDK mock) or a real Anthropic key in CI; likely pushes past SC-006 budget.
- C: **MCP tool-call driver** — harness drives `cockpit_gate_open` / `cockpit_advance` MCP tools directly; simulates the wake loop in-test; mocks the drafting call site with an instrumented handler. No `/cockpit:auto` process, but preserves the MCP boundary.

**Answer**: *Pending*

---

### Q3: Backward-compat scenario realization
**Context**: US7 / FR-008 / FR-009 require two directions of backward-compat: a **cluster without Phase B** (omits `runId`) still completes a cycle, and a **pre-Phase-A gate doc** (no `generation` field) still lists via the fallback. The spec is silent on how the harness represents "old cluster" and "old doc" — this determines whether the test proves version-skew safety or only proves the flag paths.
**Question**: How does the harness realize the two compat scenarios?
**Options**:
- A: **Flags on the same code path** — env var / config flag omits `runId` on send (FR-008) and skips `generation` on write (FR-009). One binary, two config shapes. Weakest: proves the current build honors the flag, not that a genuinely older build interoperates.
- B: **Pin old published packages** — install a pre-Phase-B `@generacy-ai/*` version in a sub-fixture (FR-008); write a hand-crafted pre-Phase-A gate doc directly to storage (FR-009). Closest to true version-skew; heaviest fixture; may not be trivially available if pre-Phase-B is not published yet.
- C: **Hybrid: flag for cluster, direct write for doc** — config flag drops `runId` on send (FR-008); FR-009 tests a hand-crafted pre-Phase-A doc written directly to cloud storage. Asymmetric but each direction picks the honest tool for the job.

**Answer**: *Pending*

---

### Q4: FR-004 draft-count signal
**Context**: FR-004 says the drafting subagent runs "exactly once" across N≥3 wakes and Assumption 3 says "instrumented emit counts are the observation surface for FR-004 and FR-007. If either surface is missing, this issue must add it as part of the harness rather than substitute a weaker signal." That leaves open where the count comes from — an existing log line, a new structured event, or an in-process spy.
**Question**: How is the draft-count observability produced?
**Options**:
- A: **Add a structured log event in this PR** — emit `event: 'cockpit-draft-spawn'` from the drafting call site in the agency skill; harness greps stdout for occurrence count. Requires a companion agency-repo PR; makes the signal usable outside tests too.
- B: **In-process spy on the subagent entry-point** — if the harness calls drafting JS directly (Q2 → A), a `vi.spyOn` on the entry gives the count for free. No production-code change; tightly coupled to Q2 = A.
- C: **Existing log line** — assume some existing log/event already emits per-draft; harness only asserts count. Faster if true; no such line is visible in the referenced plan/spec.

**Answer**: *Pending*

---

### Q5: SC-002 per-phase-revert protocol
**Context**: SC-002 says "each of the seven verification items maps to at least one failing test assertion when the corresponding phase is reverted" and describes reverting each phase in isolation and confirming attributable failure. The spec doesn't say whether this is a review-time manual protocol, a fault-injection feature of the harness, or a follow-up.
**Question**: How is SC-002 exercised?
**Options**:
- A: **Reviewer manual, once per PR** — SC-002 is a review-time protocol: reviewer reverts each phase in a scratch env, re-runs the harness, attaches attributable-failure evidence to the PR. No harness code required.
- B: **Fault-injection flags per phase** — harness supports env flags that simulate each phase's revert (e.g. `SIMULATE_PHASE_A_MISSING=1` → cloud drops `generation` on write; `SIMULATE_PHASE_C_MISSING=1` → skill omits `runId`). CI runs healthy + N simulated-revert scenarios. Larger harness surface, permanent regression coverage.
- C: **Out of scope for this PR** — ship the happy-path harness only; treat SC-002 as a follow-up ticket. Faster to land; leaves the load-bearing per-phase attribution informal.

**Answer**: *Pending*
