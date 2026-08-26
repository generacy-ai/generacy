# Quickstart: Remediate phase executor (#1128)

## What this ships

A real `remediate`-phase executor that fixes review findings, bounded by a
resettable `remediationCount` that raises a resumable `waiting-for:remediation-limit`
gate at the cap. Replaces the inert `runStubPhase('remediate')` from #1121.

## Prerequisites

All merged to `develop`:

- #1121 — phase machinery + `remediateTrigger` seam
- #1124 — review executor + findings sidecar + `on-remediation-limit` gate + `waiting-for:remediation-limit` label + `maxRemediations`
- #1125 / #1126 — PR posting + re-review convergence

## Enabling

The `review`/`remediate` loop is behind `reviewPhaseEnabled` (env `WORKER_REVIEW_PHASE_ENABLED`).
With the flag OFF (default), both phases are absent from the effective sequence, the seam
never fires, and `RemediateExecutor` never constructs (FR-013 / SC-007 byte-identity).

```bash
export WORKER_REVIEW_PHASE_ENABLED=true
```

## Loop behavior

1. `review` computes a verdict from the findings sidecar.
2. On `changes-required`, the seam runs `RemediateExecutor.execute()` — one code-change
   loop over the open blocking findings — then commits/pushes and re-enters `review`.
3. Each `execute()` increments `remediationCount` by exactly 1 (including timeouts).
4. When `remediationCount >= maxRemediations` **and** `verdict === 'changes-required'`,
   the loop pauses with `waiting-for:remediation-limit` + `agent:paused` and posts an
   issue comment listing the remaining open findings.

`maxRemediations`: `speckit-feature` → 3, `speckit-bugfix` → 2.

## Resuming after the cap

Add the satisfaction label to the issue:

```
completed:remediation-limit
```

On the next poll, the gate-satisfaction branch resets `remediationCount` to 0, clears
the label so the gate re-arms, and resumes at `review` (`GATE_MAPPING['remediation-limit']`
= `{ phase: review, resumeFrom: review }`) with a fresh remediation budget.

## What the executor never does (FR-004)

- Never resolves review threads.
- Never marks the PR ready / converts draft state.
- Never writes GitHub review state (`APPROVE`/`REQUEST_CHANGES`/`COMMENT`).
- Never touches `round` or recomputes `verdict` — the next review round decides convergence.

## Files

| Path | Change |
|------|--------|
| `packages/orchestrator/src/worker/remediate-executor.ts` | NEW |
| `packages/orchestrator/src/worker/remediate-charter.ts` | NEW |
| `packages/orchestrator/src/worker/review-artifact.ts` | + `remediationCount`, `bumpRemediationCount`, `resetRemediationCount` |
| `packages/orchestrator/src/worker/phase-loop.ts` | seam executor + commit; gate re-key; reset-on-completed; gate body |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | construct + inject `remediateExecutor` |
| `packages/generacy-plugin-claude-code/src/launch/types.ts` | + `RemediateIntent` |
| `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` | + `'remediate'` kind + `buildRemediateLaunch` |
| `packages/workflow-engine/src/actions/github/label-definitions.ts` | + `completed:remediation-limit` |

## Tests

```bash
pnpm --filter @generacy-ai/orchestrator test remediate-executor
pnpm --filter @generacy-ai/orchestrator test remediate-charter
pnpm --filter @generacy-ai/orchestrator test review-artifact.remediation-count
pnpm --filter @generacy-ai/orchestrator test phase-loop.remediate
```

## Troubleshooting

- **Loop never escalates on repeated timeouts** — confirm the increment fires on every
  return path (normal exit, timeout, spawn-failure catch). A timed-out attempt still
  consumes budget (Q4=A / INV-2).
- **Gate never fires** — check the predicate is keyed on `remediationCount`, not `round`
  (FR-007), and the `verdict === 'changes-required'` conjunct still holds.
- **Resume doesn't re-arm** — verify `completed:remediation-limit` is registered in
  `label-definitions.ts` so `ensureRepoLabelsExist` creates it, and that the satisfaction
  branch both resets the counter and removes the label.
- **Pre-#1128 artifact fails to parse** — the `.default(0)` on `remediationCount` is
  load-bearing; without it, `readReviewArtifact` returns `null` and the gate/seam break.
