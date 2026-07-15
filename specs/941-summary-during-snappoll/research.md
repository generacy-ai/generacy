# Research: Address-pr-feedback gate advance defect (#941)

## Question 1: Where is the offending writer of `completed:implementation-review`?

**Recon.** Grep across `packages/orchestrator/src` for `addLabels(` calls that could carry `completed:<gate>`:

```
packages/orchestrator/src/worker/label-manager.ts:107   labelOp: addLabels([phaseLabel])                # phase:<name> — NOT gate
packages/orchestrator/src/worker/label-manager.ts:128   labelOp: addLabels([completed:<phase>])         # completed:<phase> — worker phase
packages/orchestrator/src/worker/label-manager.ts:152   labelOp: addLabels([<gateLabel>, agent:paused]) # waiting-for:<gate> — NOT completed
packages/orchestrator/src/worker/label-manager.ts:201   labelOp: addLabels([failed:<phase>, agent:error])
packages/orchestrator/src/worker/label-manager.ts:270   labelOp: addLabels([agent:in-progress])
packages/orchestrator/src/worker/label-manager.ts:433   applyLabels — the shared wrap
packages/orchestrator/src/services/label-monitor-service.ts:383   addLabels([agent:in-progress, workflow:<name>])
packages/orchestrator/src/services/pr-feedback-monitor-service.ts:359   addLabels([waiting-for:address-pr-feedback])
packages/orchestrator/src/worker/validate-fix-handler.ts:259,293  addLabels([blocked:*])
packages/orchestrator/src/worker/pr-feedback-handler.ts:747  addLabels([blocked:stuck-feedback-loop])
packages/orchestrator/src/worker/epic-post-tasks.ts:123,217  addLabels([waiting-for:children-complete, dispatched])
packages/orchestrator/src/worker/merge-conflict-handler.ts:703  addLabels([blocked:stuck-merge-conflicts])
```

**Finding.** No current orchestrator-internal code path constructs a `completed:implementation-review` string literal or template. `LabelManager.onPhaseComplete` writes `completed:<phase>` where `<phase>` ∈ `{ specify, clarify, plan, tasks, implement, validate }` — none of which alias a gate suffix. `MergeConflictHandler.applySuccessDisposition` *removes* `completed:merge-conflicts`, does not add it.

**Conclusion.** Either the write comes from a code path this grep missed (dynamic string construction, transitive helper), or from a monitor/webhook path outside the orchestrator worker tree. The Q1 → C answer accepts this uncertainty: install the guard, let CI + first-touch runs reveal the callsite, then remove/rewrite the writer in the same PR.

## Question 2: Where should the guard live — `applyLabels` vs. a public method?

**Alternatives considered.**

- **A. Runtime guard in `LabelManager.applyLabels` (chosen).** One seam, one predicate, one throw. Catches unknown current writers (Q1 diagnosis) and future refactors that reintroduce direct `addLabels` calls with `completed:<gate>` payloads. Q4 → A.
- **B. Per-caller assertions.** Each writer site throws unless justified. Rejected: only covers writers we've already found — the whole reason the defect exists is that we haven't found the writer.
- **C. Test-only invariant** (grep-based lint). Rejected: regressed by the first refactor; no runtime signal in production; misses dynamic string construction entirely.

**Decision.** Runtime guard in the private `applyLabels()` method. Cheap: one prefix-check + one set-lookup per call. Consumers are ≤ 5 in-process; the extra CPU is invisible.

## Question 3: Should the token union have one member or zero?

**Options.**

- **A. Zero-member union (`never`).** All `completed:<human-gate>` writes rejected unconditionally. Semantically clean given `cockpit advance` writes over the wire and never enters `LabelManager`.
- **B. One-member union (`AllowGateComplete.CockpitAdvance`) with no in-process call sites (chosen).** Matches Q2's answer and reserves an extension point. If a future in-process cockpit-advance path needs to add the label (e.g. an MCP tool that piggybacks on orchestrator's `GitHubClient`), the token is already defined and the guard doesn't need to change.

**Decision.** Option B. The unit test suite (FR-007 point (b)) exercises the "with token" branch even though no production caller uses it — this locks the semantics against regression.

## Question 4: Where does FR-002's re-add call site sit?

**Options.**

- **A. Inside the shared `finally` block (chosen).** `pr-feedback-handler.ts:411-416` already has the `finally` scaffolding (#926). Add a call to `ensureImplementationReviewGate()` immediately before `clearInProgressLabel(...)`. Ordering rationale: re-add the gate label first, then clear `agent:in-progress`, so the terminal transient state is never `{ agent:in-progress, no-gate }`.
- **B. Per-branch calls.** Rejected: 5+ exit points, easy to miss one — the whole reason #926 added the `finally` was to eliminate this class of miss.

**Decision.** Option A.

## Question 5: What is the "human gate" predicate?

**Options.**

- **A. Reject every `completed:*`.** Too broad — breaks `onPhaseComplete(phase)` writes.
- **B. Reject every `completed:<X>` where `waiting-for:<X>` appears as a gate label in the effective `GATE_MAPPING` (chosen).** Precise: matches the phase-resolver's own view of what a gate is. Auto-updates if `WORKFLOW_GATE_MAPPING` grows.
- **C. Reject every `completed:<X>` where `X` is not a `WorkflowPhase`.** Same effective behaviour as B today, but couples `LabelManager` to `WorkflowPhase` enum shape. B is more direct.

**Decision.** Option B. Suffix set derived from `Object.keys(GATE_MAPPING)` plus every workflow-specific map in `WORKFLOW_GATE_MAPPING`. Const-computed once at module load.

## Question 6: What error type does the guard throw?

Choose a named subclass so callers can catch-and-classify. `class HumanGateCompletionUnauthorizedError extends Error` with fields `{ label: string, allowedTokens: readonly string[] }`. Thrown synchronously inside `applyLabels`, wraps into the existing `retryWithBackoff` context on the outer `retryWithBackoff` failure path (the retry loop will retry once — a permanent unauthorized error should surface after retries as `TerminalLabelOpError`, since the retry can't fix an authorization defect). Considered but rejected: making the error non-retryable via an in-loop `instanceof` check — a false economy that couples `retryWithBackoff` to guard-specific error types. Three retries of the same unauthorized call take ~7s and still terminate loud; the diagnostic surface is the important part, not the latency.

## Sources / references

- Spec: `specs/941-summary-during-snappoll/spec.md`
- Clarifications: `specs/941-summary-during-snappoll/clarifications.md` (Batch 1 Q1–Q5)
- Related label-flow architecture: `packages/orchestrator/src/worker/label-manager.ts` (LabelManager)
- Gate mapping source of truth: `packages/orchestrator/src/worker/phase-resolver.ts:9-30` (`GATE_MAPPING`, `WORKFLOW_GATE_MAPPING`)
- Prior structural cleanup enabling FR-002: #926 (shared `finally` in `PrFeedbackHandler.handle()`)
- Anonymous-writer incident evidence: `christrudelpw/snappoll#3` / PR #14 timeline in `spec.md`
