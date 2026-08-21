# Contract: `readFindingsArtifact` reader seam (FR-001 / FR-005)

`packages/orchestrator/src/worker/phase-loop.ts` — `PhaseLoopDeps.readFindingsArtifact`. Supplied by a closure at the `claude-cli-worker.ts` wiring site (FR-001). Default `undefined` keeps the review side-effect block inert (FR-009).

## Signature

```ts
type FindingsRead = { artifact: FindingsArtifact; round: number };

readFindingsArtifact?: (context: WorkerContext) => Promise<FindingsRead | null>;
```

**Change from the dead surface**: the old shape passed the loop-local `round` *in* as a parameter and returned a bare `FindingsArtifact`. Now `round` is an **output** derived from the sidecar (Q4=A). The old `round` input parameter is dropped.

## Closure implementation (in `claude-cli-worker.ts`)

```ts
readFindingsArtifact: async (ctx) => {
  const artifact = await readReviewArtifact(
    ctx.checkoutPath,
    `${ctx.item.owner}/${ctx.item.repo}#${ctx.item.issueNumber}`,
  );
  if (artifact === null) return null;
  return {
    artifact: bridgeReviewArtifact(artifact, blockingSeverity),
    round: artifact.round,
  };
},
```

- `workflowId` = `${owner}/${repo}#${issueNumber}` — identical to the existing `remediateTrigger` closure.
- `blockingSeverity` = `resolveWorkflowOverrides(effectiveConfig, orchSettings, item.workflowName).review.blockingSeverity`, resolved once and closed over.
- Reuses the async `readReviewArtifact` (null on missing / unreadable / invalid).

## Behavior contract

- No sidecar / invalid sidecar → `readReviewArtifact` returns `null` → reader returns `null` → the review side-effect block no-ops (FR-009 inertness).
- Valid sidecar → returns the bridged `FindingsArtifact` (FR-002/003) paired with the **raw sidecar `round`** (FR-005).
- `round` is the authoritative posting/gating round — not the loop-local `reviewRound` (which resets to 1 each run and would dedupe-skip re-review after a pause).

## Block consumption (phase-loop.ts)

```ts
if (phase === 'review' && result.success && deps.readFindingsArtifact && deps.reviewPoster) {
  const read = await deps.readFindingsArtifact(context);
  if (read) {
    const { artifact, round } = read;
    await deps.reviewPoster.postRound(artifact, round);
    if (round >= 2) await deps.reviewPoster.resolveResolvedThreads(artifact);
    if (artifact.verdict === 'clean') await prManager.markReadyForReview(context.linkedPRs);
  }
}
```
