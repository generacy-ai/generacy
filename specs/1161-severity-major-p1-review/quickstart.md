# Quickstart: Review-phase convergence (post-collapse)

**Feature**: `1161-severity-major-p1-review` | **Package**: `@generacy-ai/orchestrator`

How to run, test, and troubleshoot the engine-native review path after the schema
collapse and convergence activation.

## Enabling the review phase

The whole path is behind a feature flag (default OFF):

```bash
export WORKER_REVIEW_PHASE_ENABLED=true   # gates `review` into the phase sequence
```

With the flag OFF, the cluster is byte-identical to before this change.

## Effective `blockingSeverity` (D3)

| Workflow | Default `blockingSeverity` |
|---|---|
| `speckit-feature` | `major` |
| everything else (`speckit-bugfix`, `speckit-epic`, …) | `critical` |

Override per workflow in cluster settings (`workflows.<name>.review.blockingSeverity`);
the override is resolved identically by the executor, the gate, and the convergence
merge (no `settings = null` path remains).

## The findings sidecar

- **Path**: `<checkout>/.generacy/review-findings-<sanitized-workflowId>.json`
- **workflowId**: `${owner}/${repo}#${issueNumber}` (sanitized `[^a-zA-Z0-9_-] → _`)
- **Shape**: canonical `ReviewArtifact` (see `data-model.md`) — `findings[]` each with a
  stable `id`, `verdict`, 1-based `round`, `lastReviewedCommitSha`, `remediationCount`,
  `markedReadyByEngine`.
- The engine recomputes `verdict` on every write; an agent-claimed verdict is ignored.

## Running tests

```bash
# Whole orchestrator suite
pnpm --filter @generacy-ai/orchestrator test

# Targeted: schema + verdict + severity
pnpm --filter @generacy-ai/orchestrator test review-artifact

# Targeted: convergence merge (anti-vanish, delta scoping)
pnpm --filter @generacy-ai/orchestrator test findings-advance review-delta

# Targeted: poster (canonical input, #1156 lifecycle preserved)
pnpm --filter @generacy-ai/orchestrator test review-poster
```

Key assertions:
- **SC-001** exactly one findings-artifact schema type under `worker/`.
- **SC-002/SC-003** one `computeVerdict`, one `SEVERITY_RANK`.
- **SC-004** no `settings = null` verdict resolution; override parity across consumers.
- **SC-005** a round-1 finding omitted by the round-2 candidate stays `open`.
- **SC-006** single source of round (sidecar); no drifting PhaseTracker key.
- **SC-007** docs default matches the code constant.

## Verifying the collapse (grep audits)

```bash
# SC-001 — one schema; the two orphans are gone
ls packages/orchestrator/src/worker/review-findings-artifact.ts \
   packages/orchestrator/src/worker/review/findings-artifact.ts \
   packages/orchestrator/src/worker/review-findings-bridge.ts 2>&1   # expect: no such file

# SC-002 — one computeVerdict
grep -rn "function computeVerdict\|computeVerdict =" packages/orchestrator/src   # expect: 1

# SC-003 — one severity table
grep -rn "SEVERITY_RANK\s*[:=]\|SEVERITY_ORDER" packages/orchestrator/src        # expect: 1 definition

# SC-004 — no settings=null resolution
grep -rn "resolveWorkflowOverrides([^,]*,\s*null" packages/orchestrator/src      # expect: 0
```

## Changeset

Add before opening the PR (required CI gate — non-test `src/` change):

```
.changeset/1161-collapse-findings-schema-activate-convergence.md
```

`@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix`). Internal
consolidation + bug fix; no new public exports, no new label vocabulary. Verify with
`pnpm changeset status`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Review never posts / lifecycle inert | `WORKER_REVIEW_PHASE_ENABLED` unset | export the flag |
| PR mid-loop wedges after redeploy | sidecar predates `id` | back-compat parse default-fills `id`; confirm `readReviewArtifact` fill path runs |
| A finding vanished across rounds | executor trusted the candidate wholesale | ensure `advanceArtifact` runs with real prior + delta inputs (carry-forward) |
| Two verdicts for one PR | a consumer resolved `blockingSeverity` with `null` | all consumers must use `resolveWorkflowOverrides(config, this.settings, workflow)` |
| Round counter disagrees | a separate PhaseTracker round key survived | delete `runReviewConvergence` + its key; sidecar `round` is the only source |
| `major` finding not blocking on a feature | default is `major` only for `speckit-feature` | confirm workflow name / override |

## Next step

`/speckit:tasks` to generate the dependency-ordered task list.
