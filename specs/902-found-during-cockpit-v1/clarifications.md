# Clarifications for Issue #902

<!-- Feature: MergeConflictHandler success path dead-parks the workflow -->

## Batch 1 — 2026-07-10

### Q1: Re-arm mechanism (resume-pair vs direct enqueue)
**Context**: FR-002 offers two mechanisms for re-arming the interrupted phase and calls the choice "an implementation detail." They differ materially in surface area, testability, and race behaviour: (a) resume-pair writes `waiting-for:<preceding-gate>` + `completed:<preceding-gate>` + `agent:paused` and waits for label-monitor's next poll to enqueue a `continue` item — asserted end-to-end via label-monitor → poll → dispatch; (b) direct enqueue calls the queue directly with `command: 'continue'` and the correct `startPhase`, skipping the label-monitor round-trip — asserted at the queue boundary in a unit test. Picking one now avoids the implementation defaulting to whichever is more convenient at the call site and prevents a second round of clarification when tests are written.
**Question**: Which re-arm mechanism should `MergeConflictHandler`'s success path use?
**Options**:
- A: Resume pair only (FR-002 (a)) — write `waiting-for:<gate>` + `completed:<gate>` + `agent:paused`, let label-monitor observe and enqueue; regression asserts the poll-path handoff end-to-end.
- B: Direct enqueue only (FR-002 (b)) — call `queue.enqueue({command: 'continue', startPhase})` directly; #879 in-flight dedupe collapses the webhook+poll race; regression asserts queue state at the boundary.
- C: Whichever is cleanest at the call site (leave to implementer as FR-002 currently states); regression fixtures cover both mechanisms.

**Answer**: *Pending*

### Q2: Discovering "the interrupted phase" at handler exit
**Context**: `MergeConflictHandler.handle(item, checkoutPath)` (packages/orchestrator/src/worker/merge-conflict-handler.ts:115) receives a `QueueItem` with no `phase` field, and `ResolveMergeConflictsMetadata` (packages/orchestrator/src/types/monitor.ts:56) only carries `conflictedPathsAtPause` + `prNumber`. So today the handler has no in-band knowledge of the phase that hit the conflict. The spec's Assumptions block says "if it doesn't [have context], that plumbing is in scope for this fix." Three plumbing options are visible: (a) add `phase: WorkflowPhase` to `ResolveMergeConflictsMetadata` and set it at the pause site in the phase loop; (b) re-derive the phase from the issue's `completed:<phase>` labels at handler exit (uses `PhaseResolver` inverse-of-`resolveStartPhase`, no protocol change); (c) both — carry it in metadata *and* fall back to label-derivation as a defensive check.
**Question**: How should `MergeConflictHandler` discover the interrupted phase at its success exit?
**Options**:
- A: Add `phase` to `ResolveMergeConflictsMetadata` and thread it from the phase-loop pause site (in-band, canonical, one point of truth).
- B: Re-derive from labels at handler exit via `PhaseResolver.resolveStartPhase({command: 'continue', ...})`-equivalent inverse logic (no protocol change; handler self-contained).
- C: Both — carry in metadata as primary, fall back to label-derivation if missing (defence-in-depth).

**Answer**: *Pending*

### Q3: Preceding-gate mapping source (only matters if Q1 chose A or C)
**Context**: If re-arm uses the resume pair, the handler needs `resolvePrecedingGate(phase)`. That function exists today only in `packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts` (CLI package, not depended on by orchestrator). The Assumptions block cites "or its orchestrator-side equivalent." The orchestrator already has forward gate mapping in `packages/orchestrator/src/worker/phase-resolver.ts` (GATE_MAPPING + WORKFLOW_GATE_MAPPING at lines 9 + 27) — but as gate→phase, not the inverse the handler needs. Three options: (a) extract shared preceding-gate mapping into a shared package (e.g., `@generacy-ai/workflow-engine` or a new `@generacy-ai/gate-vocabulary`) and use it from both CLI and orchestrator; (b) add an inverse function next to `GATE_MAPPING` in orchestrator's `phase-resolver.ts`, mirroring the CLI's algorithm (some duplication, no cross-package dep); (c) hardcode the mapping inside `MergeConflictHandler` (fastest, drift risk).
**Question**: If the re-arm mechanism uses the resume pair (Q1 = A or C), where should the preceding-gate mapping live?
**Options**:
- A: Extract shared preceding-gate mapping into a shared package used by both CLI (`resume`, `advance`) and orchestrator (`MergeConflictHandler`).
- B: Add an inverse function alongside `GATE_MAPPING` in `packages/orchestrator/src/worker/phase-resolver.ts`, mirroring the CLI algorithm; accept the local duplication.
- C: N/A — Q1 answered B (direct enqueue), so no preceding-gate mapping is needed.

**Answer**: *Pending*

### Q4: Terminal-outcome invariant — location and enforcement
**Context**: FR-005/FR-006 introduce a terminal-outcome invariant (`re-armed | gated | failed | done`) as a shared type and a post-exit assertion helper. Two orthogonal decisions block implementation: (i) *where* the shared type lives — in orchestrator-only (`packages/orchestrator/src/worker/`), or a shared package (`@generacy-ai/workflow-engine`) — matters because non-orchestrator handlers may exist later; (ii) *how* it's enforced — pure typescript exhaustiveness on a discriminated union at handler exit (compile-time only, cheap, no runtime cost), a runtime post-exit assertion in test infrastructure that reads the actual label set + queue state (as FR-006 describes, catches drift between the returned outcome and reality), or both. Both directions were plausible from the spec; FR-011 wants the runtime assertion applied to *every* handler's fixtures, which weakly implies the assertion helper is the load-bearing artefact.
**Question**: How should the terminal-outcome invariant be codified and enforced?
**Options**:
- A: Discriminated union type in `packages/orchestrator/src/worker/` (orchestrator-only) + runtime post-exit assertion helper reading labels + queue; type ensures every handler exit returns one outcome, assertion verifies labels match. Applied to `MergeConflictHandler` in this issue; `PrFeedbackHandler` fixture coverage per FR-011 (assertion only, no rewrite).
- B: Discriminated union in a shared package (`@generacy-ai/workflow-engine`) + runtime post-exit assertion helper. Same handler coverage as A; the shared location anticipates non-orchestrator handlers.
- C: Runtime post-exit assertion only (no shared type) — handlers keep current `void` returns; the assertion helper is the single enforcement point. Applied to `MergeConflictHandler` + `PrFeedbackHandler` fixtures per FR-011.

**Answer**: *Pending*

### Q5: Label mutation ordering on the ownership transition
**Context**: On the success path with re-arm via resume pair, the handler removes `agent:in-progress` and adds `agent:paused` (plus `waiting-for:<gate>` + `completed:<gate>`). Ordering matters because a mid-sequence crash between the two API calls leaves the issue in a transient state: (a) *add-then-remove* (paused labels applied first, then `agent:in-progress` removed) — mid-crash leaves the issue over-labelled with both `agent:in-progress` AND `agent:paused`, but every detector still sees the paused state and the issue is recoverable by label-monitor; (b) *remove-then-add* (in-progress cleared first, then paused labels applied) — mid-crash leaves the issue with `waiting-for:merge-conflicts` cleared but no `agent:paused` yet, matching no detector = a fresh dead-park (the exact failure mode this spec addresses); (c) issue a single `gh issue edit` call that computes the resulting label set and applies it atomically. #849's paired-clear used add-then-remove for the same asymmetric-partial-failure reason. Fixing this now avoids re-litigating it in review.
**Question**: What is the required label mutation ordering when the handler transitions ownership on success?
**Options**:
- A: Add-then-remove — apply `waiting-for:<gate>` + `completed:<gate>` + `agent:paused` first, then remove `agent:in-progress` + `completed:merge-conflicts`. Asymmetric partial failure = over-labelled but recoverable (never dead-parked). Mirrors #849's paired-clear.
- B: Remove-then-add — clear `agent:in-progress` + `completed:merge-conflicts` first, then apply resume-pair labels. Simpler mental model, but a mid-sequence crash produces the exact "no detector matches" dead-park class this spec addresses.
- C: Atomic single-call — compute the resulting label set and issue one `gh issue edit --add-label ... --remove-label ...` call so the transition is all-or-nothing at the GitHub API boundary.

**Answer**: *Pending*
