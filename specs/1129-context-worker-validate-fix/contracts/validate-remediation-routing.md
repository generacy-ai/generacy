# Contract: Validate-failure → remediate routing

Governs the validate-failure branch of `PhaseLoop.executeLoop`
(`packages/orchestrator/src/worker/phase-loop.ts`) when `review` is in the
effective sequence.

## Preconditions

- `phase === 'validate'` and `result.success === false`.
- `reviewPhaseEnabled === true` (else: current escalation, feature inert — SC-005).

## Step 1 — Fingerprint-first escalation (FR-006 / FR-009)

```
evidence   = { stdout, stderr, exitCode }         // from PhaseResult
fingerprint = computeFailureFingerprint({ phase: 'validate', evidence })
occurrence  = countPriorOccurrences(owner, repo, issue, fingerprint) + 1

postFailureAlert({ stage, runId, phase: 'validate', evidence, fingerprint, occurrence })
// NOTE: onError('validate') is NOT called → failed:validate is never applied (FR-009)

if occurrence >= REPEAT_FAILURE_THRESHOLD:      // 2
    onRepeatedError('validate')                 // failed:validate-repeated (terminal)
    return { results, completed: false, lastPhase: 'validate', gateHit: false }
```

- MUST NOT apply `failed:validate` on the routed path.
- `failed:validate-repeated` is the sole terminal failure label.

## Step 2 — Synthesize the changes-required artifact (FR-001 / FR-002)

```
prior = readReviewArtifact(checkoutPath, workflowId)        // may be null
round = (prior?.round ?? 0) + 1
finding = {
  severity: 'critical', file: <validateCommand>,
  title: 'validate phase failed', detail: boundTail(evidence),
  round, status: 'open',
}
writeReviewArtifact(checkoutPath, workflowId, {
  findings: [...(prior?.findings ?? []), finding],
  verdict: 'changes-required',
  round,
  lastReviewedCommitSha: <HEAD>,
})
```

- The same artifact the review seam uses ⇒ the `on-remediation-limit` gate reads
  the advanced `round` against the shared `maxRemediations` (no separate budget).

## Step 3 — Set control + backtrack

```
pendingValidateRemediation = { evidence, prNumber, baseBranch }   // baseBranch: 'origin/'-stripped
i = sequence.indexOf('review') - 1
continue
```

- `prNumber` MUST be defined (a PR exists by the validate phase); if absent, fall
  back to the pre-existing escalation (defensive) rather than routing.

## Step 4 — `review` re-entry while `pendingValidateRemediation` set

- MUST skip `runReviewConvergence(...)`.
- MUST skip `reviewExecutor.execute(...)`; set `result = runStubPhase('review')`.
- The `on-remediation-limit` gate still evaluates: if
  `artifact.round >= maxRemediations && verdict === 'changes-required'` →
  pause with `waiting-for:remediation-limit` + `agent:paused` (FR-009). The loop
  returns; `pendingValidateRemediation` is discarded (artifact is authoritative).
- Otherwise the `remediateTrigger` fires (`verdict === 'changes-required'`).

## Step 5 — Remediate seam dispatch (FR-005 / FR-008)

```
onPhaseStart('remediate')
if pendingValidateRemediation:
    convertToDraftIfEngineMarkedReady(linkedPRs)
    validateFixHandler.handle(item, checkoutPath,
        { prNumber, baseBranch }, evidence, github, workflowName)   // real fix + sibling guard
    pendingValidateRemediation = undefined
else:
    runStubPhase('remediate')                                       // review-origin, unchanged
onPhaseComplete('remediate')
reviewRound++
i--                       // re-enter review
continue
```

- The legacy handler is invoked at **this site only** — the direct `handle()` call
  in the validate-failure branch (old #892) is deleted (FR-008/SC-003).

## Step 6 — Second `review` re-entry (FR-003)

- `pendingValidateRemediation === undefined` ⇒ real `reviewExecutor.execute()`
  runs delta-scoped, overwrites the artifact with a recomputed verdict.
- Clean ⇒ `markReadyForReview`, `remediateTrigger` false ⇒ advance to `validate`.
- Validate re-runs; one base-merge per cycle preserved by the block-local
  `hasBaseMergedThisCycle` (FR-007).

## Invariants

| Invariant | Enforced by |
|-----------|-------------|
| Routed remediation counts against `maxRemediations` | advancing artifact `round`; `on-remediation-limit` gate |
| No `failed:validate` on routed path | Step 1 omits `onError('validate')` |
| Exactly one recovery path per failure | #892 block replaced; handler called only at remediate seam |
| One base-merge per cycle | block-local `hasBaseMergedThisCycle` re-init per iteration |
| Feature inert when `reviewPhaseEnabled=false` | `review` absent from effective sequence |
