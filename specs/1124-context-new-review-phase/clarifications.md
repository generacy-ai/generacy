# Clarifications: Review phase executor — structured findings artifact + engine-internal verdict

## Batch 1 — 2026-08-19

### Q1: Findings handoff mechanism
**Context**: FR-005/FR-006 say the agent produces structured findings and the engine validates and persists them, but the spec never states *how* the agent's output reaches the engine. This is the core seam of the executor and blocks implementation.
**Question**: How does the agent's review output reach the engine for validation?
**Options**:
- A: Charter instructs the agent to write the findings artifact to a known sidecar path. Engine reads it, Zod-validates, recomputes the verdict, and rewrites atomically (temp+rename). Any agent-claimed verdict is ignored.
- B: Agent emits a fenced JSON findings block in its CLI output; engine parses the captured stdout, validates, then writes the sidecar itself. Agent never touches the filesystem artifact.
- C: Agent submits findings through a dedicated MCP tool call whose result the engine captures and validates.

**Answer**: *Pending*

### Q2: Verdict → next-phase wiring
**Context**: FR-008 routes `changes-required` into the existing `remediateTrigger` seam. The mechanism connecting the engine-computed verdict to the trigger / next-phase decision is unspecified. The current code is `if (phase === 'review' && result.success && deps.remediateTrigger?.(context))`.
**Question**: How does the computed verdict connect to the remediate trigger / next-phase decision?
**Options**:
- A: Review executor returns the verdict on the `PhaseResult`; phase-loop reads `result.verdict` directly to decide continue-vs-remediate (remediateTrigger becomes verdict-driven).
- B: Executor only writes the artifact; the existing `remediateTrigger(context)` reads the persisted artifact's verdict to return its boolean.
- C: Executor sets a verdict field on `WorkerContext` that both the trigger and the phase-loop consult.

**Answer**: *Pending*

### Q3: Review↔remediate loop termination
**Context**: `remediate` is still a stub (no-op) in this issue (per Assumptions/Out of Scope). On `changes-required`, the loop enters `remediate` then re-enters `review` with an unchanged diff → the same verdict → an infinite review↔remediate spin (`i--; continue;`). The spec does not bound this.
**Question**: How should the review↔remediate cycle be bounded while `remediate` is a stub?
**Options**:
- A: Bound the cycle with a max-round count; on exhaustion escalate/pause the workflow with a review gate label instead of looping forever.
- B: While `remediate` is a stub, `changes-required` does NOT enter the seam — it pauses the workflow with a review gate label. The remediate loop lands with the real remediate executor.
- C: Use the resolved `review.failThenPass` config: fail once, then force a pass on the next round so the loop terminates.

**Answer**: *Pending*

### Q4: Charter prompt delivery
**Context**: FR-002 selects the charter prompt by `review.profile`. The delivery mechanism to the CLI spawn is unspecified, and `review` is not currently in the launcher's `PHASE_TO_COMMAND` map (the CLI phase path today passes `context.issueUrl` as the prompt and maps phase→command).
**Question**: How is the profile-selected review charter prompt delivered to the CLI spawn?
**Options**:
- A: Add a profile-selected `/speckit:review` slash command; executor spawns it via `cli-spawner` like other phases, passing the issue URL.
- B: Engine builds the charter prompt string in-process (selected by profile) and passes it as the CLI prompt — no new slash command registered.
- C: Charter text lives as a file in the claude-code plugin; the spawn references it by path/name.

**Answer**: *Pending*
