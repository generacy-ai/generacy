# Contract: Unified remediate seam (validate-origin + review-origin)

Location: `packages/orchestrator/src/worker/phase-loop.ts`, the `if (phase === 'review' && result.success && deps.remediateTrigger?.(context))` block (currently `:1708-1775`).

## Before (defective)

```
if (pendingValidateRemediation) {
  await deps.validateFixHandler?.handle(...);   // no budget bump, no timeout, ignores exit
  pendingValidateRemediation = undefined;
  remediateResult = this.runStubPhase('remediate');   // synthetic success
} else {
  remediateResult = deps.remediateExecutor ? await execute(context) : stub;
  const outcome = await commitPushAndEnsurePr('remediate');
  if (outcome.pushRefused) return abort;
}
```

The validate branch never bumps `remediationCount` and always self-commits/pushes regardless of exit.

## After (unified)

```
await labelManager.onPhaseStart('remediate');

const remediateResult: PhaseResult = deps.remediateExecutor
  ? await deps.remediateExecutor.execute(context)
  : this.runStubPhase('remediate');

// FR-007 / Q3=B: preserve partial work on a timeout-kill; skip commit/push on a
// clean-run non-zero exit (fixer completed and failed → do not ship a broken fix).
const shouldPush = remediateResult.exitCode === 0 || remediateResult.timedOut === true;
if (shouldPush) {
  const outcome = await prManager.commitPushAndEnsurePr('remediate');
  if (outcome.pushRefused) {
    return { results, completed: false, lastPhase: 'remediate', gateHit: false };
  }
  if (outcome.prUrl) context.prUrl = outcome.prUrl;
}

await labelManager.onPhaseComplete('remediate');
results.push(remediateResult);
outputCapture.clear();
i--; // re-enter review
continue;
```

`pendingValidateRemediation` is removed (no consumer). The synthesized `changes-required` finding written at the validate-routing block feeds `RemediateExecutor`'s charter via `readReviewArtifact`.

## Guarantees

| # | Guarantee | Verified by |
|---|-----------|-------------|
| G1 | Every validate-origin remediation dispatch increments `remediationCount` exactly once (via `RemediateExecutor`'s per-return-path bump). | SC-001 |
| G2 | Both origins draw from one `remediationCount` / `maxRemediations` budget. | US1-AC4 / Q5=A |
| G3 | A timeout-kill (non-zero exit, `timedOut === true`) commits + pushes partial work. | SC-004 / Q3=B |
| G4 | A clean-run non-zero exit (`exitCode !== 0 && !timedOut`) does NOT commit or push. | SC-005 / FR-007 |
| G5 | `on-remediation-limit` becomes reachable on the validate path once the count is bumped. | FR-003 |
| G6 | With `reviewPhaseEnabled` OFF, this block never runs → byte-identical behavior. | SC-006 / FR-009 |

## Non-goals

- No thread resolution, PR-ready marking, or GitHub review-state writes in this seam (unchanged — those belong to the review executor / poster).
- No per-file sibling-overlap guard (retired with `ValidateFixHandler`; see plan RISK-1).
