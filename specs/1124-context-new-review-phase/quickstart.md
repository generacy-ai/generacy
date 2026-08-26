# Quickstart: Review phase executor (#1124)

How to build, enable, exercise, and troubleshoot the `review` phase executor in a local orchestrator checkout.

## Prerequisites

- Node ≥22, pnpm.
- Prereqs merged: **#1121** (phase machinery + `runStubPhase` + `remediateTrigger` seam) and the **review config** issue (`ResolvedWorkflowConfig.review`, `DEFAULT_REVIEW`, `resolveWorkflowOverrides`).

## Build

```bash
pnpm install
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/generacy-plugin-claude-code build
pnpm --filter @generacy-ai/workflow-engine build
```

## Enable the phase

The executor only runs when the `review` phase is in the effective sequence, which is gated by the feature flag (default OFF, byte-identical to today when off — FR-010/SC-005):

```bash
export WORKER_REVIEW_PHASE_ENABLED=true
```

Config surface (resolved per-workflow via `resolveWorkflowOverrides`):

- `review.profile` — `standard` (default) or `verification`. Selects the charter.
- `review.blockingSeverity` — `critical` (default) | `major` | `minor`. The verdict threshold.
- `review.failThenPass` — reserved config knob; NOT used as a loop terminator here.
- `maxRemediations` — review↔remediate cap (speckit-bugfix → 2, else → 3). Drives the `on-remediation-limit` gate.

## What happens on a review pass

1. `implement` completes → loop enters `review`.
2. Engine resolves `review` config, reads any prior artifact, computes `round`.
3. Engine builds the charter (by `profile`) and spawns the CLI with a `review` launch intent carrying that prompt.
4. Agent reviews the PR diff (no tests/builds) and writes findings to `.generacy/review-findings-<workflowId>.json`.
5. Engine reads + Zod-validates the file, **recomputes** the verdict from findings + `blockingSeverity`, stamps `round` + `lastReviewedCommitSha`, rewrites atomically.
6. Verdict routing:
   - `clean` → loop continues toward `validate`.
   - `changes-required` → `remediateTrigger` reads the sidecar, returns `true`, loop runs the (stub) `remediate`, then re-enters `review`.
7. If `round` reaches `maxRemediations`, the `on-remediation-limit` gate fires first and the workflow pauses with `waiting-for:remediation-limit` + `agent:paused`.

## Inspect the artifact

```bash
cat <checkout>/.generacy/review-findings-<workflowId>.json | jq
```

Expected shape:

```json
{
  "findings": [
    { "severity": "critical", "file": "src/foo.ts", "line": 42,
      "title": "Null deref on empty input", "detail": "…",
      "round": 1, "status": "open" }
  ],
  "verdict": "changes-required",
  "round": 1,
  "lastReviewedCommitSha": "a1b2c3d4"
}
```

## Run the tests

```bash
# unit — schema round-trip + null-on-malformed (SC-001), verdict gating (SC-002)
pnpm --filter @generacy-ai/orchestrator test review-artifact

# unit — charter invariants (FR-002/003/004/005)
pnpm --filter @generacy-ai/orchestrator test review-charter

# harness — no validate/build spawn (SC-003), verdict→next-phase (SC-004)
pnpm --filter @generacy-ai/orchestrator test review-executor

# integration — clean→validate, changes-required→remediate→re-review, FR-011 pause
pnpm --filter @generacy-ai/orchestrator test phase-loop.review
```

## Changeset

```bash
# hand-write .changeset/1124-review-phase-executor.md
#   @generacy-ai/workflow-engine: minor   (new waiting-for:remediation-limit label vocabulary)
#   @generacy-ai/generacy-plugin-claude-code: minor  (new 'review' launch intent kind)
#   @generacy-ai/orchestrator: patch      (internal plumbing, no new public exports)
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `review` never runs | Flag off | `export WORKER_REVIEW_PHASE_ENABLED=true` |
| `readReviewArtifact` returns `null` after a pass | Agent wrote malformed JSON or wrong shape; or wrote to a different path | Check the charter's `sidecarRelPath` matches `getReviewArtifactRelPath`; validate the file against `contracts/review-artifact.schema.json` |
| Verdict is `clean` despite a critical finding | Finding `status` is `resolved`, or `blockingSeverity` is higher than the finding | Confirm `status: 'open'`; check resolved `review.blockingSeverity` |
| Loop spins review↔remediate forever | `maxRemediations` not threaded, or the `on-remediation-limit` gate not registered | Verify the worker injects `settings`; confirm `GateDefinitionSchema.condition` includes `on-remediation-limit` and the default review gate is present |
| Verdict flips based on the agent's claim | Engine trusted the agent-written `verdict` | The executor must recompute via `computeVerdict` and ignore the candidate's `verdict` (FR-005/FR-007) |
| A validate/build process ran during `review` | Wrong spawn path used | The executor must spawn the `review` intent via `agentLauncher.launch()`, never `cli-spawner.runValidatePhase` |
| Type error: `phase` not assignable in `cli-spawner.spawnPhase` | Tried to route `review` through the CLI phase path | `review` spawns on its own executor path; the CLI cast intentionally excludes it |
