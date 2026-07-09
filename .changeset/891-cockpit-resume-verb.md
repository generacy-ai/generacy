---
"@generacy-ai/generacy": minor
"@generacy-ai/orchestrator": minor
---

Add the `generacy cockpit resume <issue-ref>` verb to re-arm a failed phase (#891).

This is the engine-owned re-arm primitive the auto-mode escalation gate's
"Requeue" action needs — without it, every `agent:error` / `failed:*` escalation
degraded to Skip and a run with any failed issue could never reach
`epic-complete`. `resume` performs label surgery per the protocol: it clears
`agent:error`, `failed:<phase>`, and any stray `phase:<phase>`, then restores the
`waiting-for:<preceding-gate>` + `completed:<preceding-gate>` + `agent:paused`
triple of a naturally-paused-then-completed gate (the gate that *precedes*
`<phase>` in the workflow definition), preserving prior `completed:<earlier-phase>`
labels so the resolver restarts at `<phase>` rather than from specify. It routes
through the unified `resolveIssueContext` grammar (bare number or full URL), is
idempotent (clear no-op when the issue isn't failed), and exits non-zero with
evidence when the state can't be re-armed (no preceding gate, unknown phase
suffix, conflicting labels).

`@generacy-ai/orchestrator` now exports its phase-resolution surface
(`PhaseResolver`, `GATE_MAPPING`, `WORKFLOW_GATE_MAPPING`, `PHASE_SEQUENCE`,
`WORKFLOW_PHASE_SEQUENCES`, `getPhaseSequence`, `WorkflowPhase`) so the verb can
compute the preceding gate from the active workflow definition.
