# Contract: ExternalFeedbackSeed + SeedAwareReviewExecutor

Governs the worker-side handoff from the thin adapter (parser + seed writer) to the seed-aware
review wrapper. Consuming contract for the #1124 findings artifact; this feature adds the seed
type and the wrapper, and consumes `computeVerdict` / `writeReviewArtifact` / `clearReviewArtifact`
unchanged.

## Module: `worker/external-feedback-seed.ts` (NEW)

```ts
export interface ExternalFeedbackSeed {
  version: 1;
  prNumber: number;
  seededAt: string;              // ISO-8601
  findings: ExternalFeedbackFinding[];
}

export interface ExternalFeedbackFinding {
  id: string;
  body: string;                  // review-body findings keep the legacy no-anchor prefix
  author: string;
  path?: string;
  line?: number;
}

/** Path: <checkoutPath>/.generacy/external-feedback-<sanitize(workflowId)>.json */
export function getExternalFeedbackSeedPath(checkoutPath: string, workflowId: string): string;

/** Atomic write (temp + rename), mirroring writeReviewArtifact. */
export function writeExternalFeedbackSeed(
  checkoutPath: string,
  workflowId: string,
  seed: ExternalFeedbackSeed,
): Promise<void>;

/** Returns null on missing/malformed/unknown-version (fail-open). */
export function readExternalFeedbackSeed(
  checkoutPath: string,
  workflowId: string,
): Promise<ExternalFeedbackSeed | null>;

/** Best-effort unlink; no-op if absent. */
export function clearExternalFeedbackSeed(
  checkoutPath: string,
  workflowId: string,
): Promise<void>;
```

**Invariants**:
- `workflowId` sanitized with the same `[^a-zA-Z0-9_-] → _` rule as `review-artifact.ts`.
- `writeExternalFeedbackSeed` is only called with `findings.length >= 1`.
- `readExternalFeedbackSeed` validates with Zod; any failure → `null`.

## Module: `worker/seed-aware-review-executor.ts` (NEW)

Implements the same shape as `ReviewExecutor` and occupies the `deps.reviewExecutor` slot.

```ts
export class SeedAwareReviewExecutor {
  constructor(deps: {
    delegate: ReviewExecutor;        // the real #1124 executor
    logger: Logger;
  });

  async execute(context: WorkerContext): Promise<PhaseResult>;
}
```

**Behavior (execute)**:

1. `seed = await readExternalFeedbackSeed(context.checkoutPath, context.item...workflowId)`.
2. **Seed present**:
   - Resolve `blockingSeverity` from the workflow review config.
   - Map `seed.findings` → findings-artifact findings (`status: 'open'`, `severity:
     blockingSeverity`).
   - `verdict = computeVerdict(findings, blockingSeverity)` — MUST be `'changes-required'`.
   - `round = (priorArtifact?.round ?? 0) + 1`.
   - `lastReviewedCommitSha = await context.github.getCurrentCommitSha()`.
   - `await writeReviewArtifact(checkoutPath, workflowId, { findings, verdict, round,
     lastReviewedCommitSha })`.
   - `await clearExternalFeedbackSeed(...)` (consume-once).
   - Return synthetic success: `{ phase: 'review', success: true, exitCode: 0, durationMs, output:
     [] }`. **No CLI spawn.**
3. **Seed absent**: `return this.delegate.execute(context)` (real review, convergence round).

**Guarantees**:
- Seeding round never spawns the review CLI (SC-004 body-only preservation depends on this).
- After the wrapper returns, `remediateTrigger(context)` reads the artifact and returns `true`
  (`verdict === 'changes-required'`), firing the remediate phase — the shared loop, not the legacy
  fixer (FR-003).
- The seed is deleted before the phase loop can re-enter `review`, so convergence rounds delegate
  to the real executor (which re-derives the verdict from the actual diff and, when clean, flips
  the PR back to ready-for-review — FR-003 convergence).

## Consumed unchanged (do not modify)

- `computeVerdict(findings, blockingSeverity)` — `review-artifact.ts`.
- `writeReviewArtifact` / `readReviewArtifact` / `clearReviewArtifact` — `review-artifact.ts`.
- `remediateTrigger` seam wiring in `claude-cli-worker.ts` (predicate reads artifact verdict).
- `ReviewExecutor` — the delegate.
