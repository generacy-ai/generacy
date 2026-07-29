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

**Answer**: **A** — fake WS peer + fake HTTP cloud, **but** state the residual honestly and pin the fake to the shared schema. This is the pattern #1024 established and #1077 extended (`packages/orchestrator/src/__tests__/cockpit-gates/fake-peer.ts` already runs a real `WebSocketServer` parsing frames with `RelayMessageSchema` from `@generacy-ai/cluster-relay`). Two required mitigations: (1) **Parse, do not pick.** The fake MUST validate inbound `cluster.cockpit` frame payloads with the frozen wire schemas (`GateOpenWireSchema` / `GateOutcomeWireSchema` from generacy `mcp/gates/schemas.ts`) rather than reading fields ad hoc — real cloud reads `frameId` off raw frame data at `generacy-cloud/services/api/src/services/relay/message-handler.ts:812`; a fake reading it off the envelope would still pass. (2) Rewrite the spec's "real cloud" phrasing as *a real cluster over a real WebSocket against a schema-validated cloud fake; cluster↔cloud semantic divergence is NOT detectable by this harness and remains covered only by generacy-cloud's own suite.* **C rejected outright**: staging shares the production `generacy-ai` `(default)` Firestore across Cloud Run services — CI writes would land in production. Record this reason in `research.md` so C is not revisited as "the fast option".

---

### Q2: `/cockpit:auto` invocation surface
**Context**: FR-004 requires an assertion that the drafting subagent runs exactly once across ≥3 wakes. The observable count has to come from somewhere; the spec is silent on which layer emits it and whether `/cockpit:auto` runs as a real `claude` process. This choice determines almost every other test-file shape.
**Question**: How does the harness drive `/cockpit:auto` and count drafting-subagent spawns?
**Options**:
- A: **Direct call to drafting entry-point** — skip `claude` entirely. Test imports the drafting JS entry-point (agency's `plugin-cockpit` package) and invokes it directly with a `vi.spyOn` for the count. Deterministic, fastest, but bypasses the real `/cockpit:auto` prompt loop. **Strike from the option list** — the module does not exist: `packages/claude-plugin-cockpit/lib/` contains parsers/wire-types/vocabulary and nothing that spawns a drafting subagent. The spawn is a `subagent_type: "general-purpose"` instruction inside the `auto.md` playbook prose, executed by Claude.
- B: **Real `claude` CLI subprocess** — spawn a real `claude` process running the `/cockpit:auto` skill. Highest realism. Requires a stubbed LLM backend (SDK mock) or a real Anthropic key in CI; likely pushes past SC-006 budget.
- C: **MCP tool-call driver** — harness drives `cockpit_gate_open` / `cockpit_advance` MCP tools directly; simulates the wake loop in-test; mocks the drafting call site with an instrumented handler. No `/cockpit:auto` process, but preserves the MCP boundary.

**Answer**: **C** — MCP tool-call driver. **FR-004 must be re-scoped**, not merely re-implemented: under C there is no subagent, and a simulated wake loop calling an instrumented handler once would be asserting that *the harness's own loop* is correct (test of the test). What FR-004 actually protects is the pre-draft dedup invariant, which IS observable at the MCP boundary: across N simulated wakes for the same natural gate, `cockpit_gate_status` must return `open`/`answered` on wakes 2..N rather than `absent`, and exactly one `cockpit_gate_open` must reach the peer. Assert the mechanism, not its downstream consequence. **Division of labour must be stated in the spec**: generacy's harness pins the tool behaviour; agency's `playbook-verification.test.ts` (186 assertions as of agency#471) pins that `auto.md` consumes it correctly. Neither repo can make both claims; pretending otherwise is what produced the drift this issue exists to find.

---

### Q3: Backward-compat scenario realization
**Context**: US7 / FR-008 / FR-009 require two directions of backward-compat: a **cluster without Phase B** (omits `runId`) still completes a cycle, and a **pre-Phase-A gate doc** (no `generation` field) still lists via the fallback. The spec is silent on how the harness represents "old cluster" and "old doc" — this determines whether the test proves version-skew safety or only proves the flag paths.
**Question**: How does the harness realize the two compat scenarios?
**Options**:
- A: **Flags on the same code path** — env var / config flag omits `runId` on send (FR-008) and skips `generation` on write (FR-009). One binary, two config shapes. Weakest: proves the current build honors the flag, not that a genuinely older build interoperates.
- B: **Pin old published packages** — install a pre-Phase-B `@generacy-ai/*` version in a sub-fixture (FR-008); write a hand-crafted pre-Phase-A gate doc directly to storage (FR-009). Closest to true version-skew; heaviest fixture; may not be trivially available if pre-Phase-B is not published yet.
- C: **Hybrid: flag for cluster, direct write for doc** — config flag drops `runId` on send (FR-008); FR-009 tests a hand-crafted pre-Phase-A doc written directly to cloud storage. Asymmetric but each direction picks the honest tool for the job.

**Answer**: **C** — hybrid, **but FR-008's half needs no flag at all**. `runId` is optional on every gate schema (`CockpitGateStatusInputSchema`, `CockpitGateListInputSchema`, `GateOpenInputSchema`, `GateAckInputSchema` all declare `runId: z.string().min(1).optional()`). A pre-Phase-B cluster's wire shape is exactly "the field is absent" — the harness simply omits it, exercising the real documented path rather than a simulation of it. Adding a flag would weaken the test and add a production knob for no gain. **FR-009's half genuinely needs the direct write** — a pre-Phase-A doc has no `generation` field; under Q1=A the fake's store is ours to seed, hand-craft it. **Rejection note for B**: the cluster is source-linked (`generacy` resolves to `/workspaces/generacy/packages/generacy/bin/generacy.js`, runs the mounted source tree, published npm versions are not this deployment's mechanism). Pinning an old tarball would test a distribution path the cluster does not use.

---

### Q4: FR-004 draft-count signal
**Context**: FR-004 says the drafting subagent runs "exactly once" across N≥3 wakes and Assumption 3 says "instrumented emit counts are the observation surface for FR-004 and FR-007. If either surface is missing, this issue must add it as part of the harness rather than substitute a weaker signal." That leaves open where the count comes from — an existing log line, a new structured event, or an in-process spy.
**Question**: How is the draft-count observability produced?
**Options**:
- A: **Add a structured log event in this PR** — emit `event: 'cockpit-draft-spawn'` from the drafting call site in the agency skill; harness greps stdout for occurrence count. Requires a companion agency-repo PR; makes the signal usable outside tests too. **Unavailable under Q2=C**: "the drafting call site in the agency skill" is playbook prose, not code.
- B: **In-process spy on the subagent entry-point** — if the harness calls drafting JS directly (Q2 → A), a `vi.spyOn` on the entry gives the count for free. No production-code change; tightly coupled to Q2 = A. **Falls with Q2=A being unavailable**.
- C: **Existing log line** — assume some existing log/event already emits per-draft; harness only asserts count. Faster if true; no such line is visible in the referenced plan/spec.

**Answer**: **C** — an existing signal, **though not the one C assumes**. The suitable line already exists in `packages/orchestrator/src/routes/cockpit-gates.ts` inside `tryEmitOrRetain`: `options.logger.info({ gateId: ctx.gateId, type: ctx.type }, 'cockpit gate emitted')`. One line per frame that actually reaches the relay, carrying `gateId` and `type`. Counting occurrences per `gateId` across N wakes gives the no-duplicate-drafting signal — and it is a **stronger** observable than a subagent spawn count because it measures what reaches the operator's inbox rather than what the loop intended. **Two pinning requirements**: (1) Assert exactly one `'cockpit gate emitted'` per `(gateId)` across N wakes, and separately that the peer received exactly one `cluster.cockpit` frame for it (post-#1077 each frame carries a distinct `frameId`, so a duplicate emit is unambiguous — two frames, two ids, one gateId). (2) Record in the spec that Assumption 3's "add if missing" constraint is satisfied here **because the substitution is to a stronger signal**, one layer closer to the operator — not because the constraint was quietly waived.

---

### Q5: SC-002 per-phase-revert protocol
**Context**: SC-002 says "each of the seven verification items maps to at least one failing test assertion when the corresponding phase is reverted" and describes reverting each phase in isolation and confirming attributable failure. The spec doesn't say whether this is a review-time manual protocol, a fault-injection feature of the harness, or a follow-up.
**Question**: How is SC-002 exercised?
**Options**:
- A: **Reviewer manual, once per PR** — SC-002 is a review-time protocol: reviewer reverts each phase in a scratch env, re-runs the harness, attaches attributable-failure evidence to the PR. No harness code required.
- B: **Fault-injection flags per phase** — harness supports env flags that simulate each phase's revert (e.g. `SIMULATE_PHASE_A_MISSING=1` → cloud drops `generation` on write; `SIMULATE_PHASE_C_MISSING=1` → skill omits `runId`). CI runs healthy + N simulated-revert scenarios. Larger harness surface, permanent regression coverage.
- C: **Out of scope for this PR** — ship the happy-path harness only; treat SC-002 as a follow-up ticket. Faster to land; leaves the load-bearing per-phase attribution informal.

**Answer**: **B** — fault injection, **with a hard boundary: no simulate-a-bug switch may ship in production code**. Under Q1=A almost every flag is fake-side configuration rather than production code: *Phase A reverted* → configure the fake's store not to persist `generation` (a property of the fake); *Phase B reverted* → the harness's query client omits `runId` (under Q3 this is not even a flag — it is not passing an optional field); *Phase C reverted* → the harness does not pass `runId` on open/ack (same). **Requirement to state in the spec**: no `SIMULATE_PHASE_*` switch may exist in a shipped code path. A production binary carrying env-var-triggered "behave like the broken version" branches is a genuine hazard — one misconfiguration from being the broken version in a real cluster, and it inverts the meaning of every log line around it. Every knob lives in harness/fixture code. **If any of the seven items turns out to be un-revertable without touching production code, drop that item to A for that item and name it in the spec as manually attributed, rather than adding the production flag.** SC-002 also needs a scoping tightening: assert **attribution**, not just failure — the test that fails when Phase A is reverted should be the one about `generation` storage, not an unrelated cascade. A revert that reddens the whole suite proves coupling, not attribution.
