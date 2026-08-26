# Data Model: PR-feedback monitor rewrite (#1130)

All new state is **checkout-local, per-job, ephemeral**. No Redis keys, no issue/PR markers, no
persisted store. The seed lives only for the duration of one `address-pr-feedback` job.

## Entity: ExternalFeedbackSeed

The artifact the thin adapter writes and the seed-aware review wrapper consumes. Written by the
worker after dual-source extraction; deleted by the wrapper on first read.

**Path**: `<checkoutPath>/.generacy/external-feedback-<sanitizedWorkflowId>.json`
where `sanitizedWorkflowId` uses the same `[^a-zA-Z0-9_-] → _` sanitization as the review artifact
path helper (`review-artifact.ts` / `pause-context.ts`). Co-located with the findings artifact so a
single `.generacy/` dir holds both.

```ts
interface ExternalFeedbackSeed {
  /** Schema version for forward-compat; literal 1 for this feature. */
  version: 1;
  /** PR the feedback came from — carried for logging/trace only. */
  prNumber: number;
  /** ISO timestamp the adapter wrote the seed. */
  seededAt: string;
  /** Dual-source findings extracted from inline threads AND review bodies. */
  findings: ExternalFeedbackFinding[];
}

interface ExternalFeedbackFinding {
  /** Stable id from the source thread/comment (legacy parser `id`). */
  id: string;
  /**
   * The finding text. For review-body-only findings this preserves the legacy
   * "review body (no file anchor):\n\n<body>" prefix so no body-only ask is dropped (FR-004).
   */
  body: string;
  /** Trusted author login (authorship-based, FR-002). */
  author: string;
  /** File path when the source was an inline thread; undefined for review-body findings. */
  path?: string;
  /** Line when the source was an inline thread; undefined for review-body findings. */
  line?: number;
}
```

**Zod schema** (`external-feedback-seed.ts`): mirror the interface;
`version: z.literal(1)`, `findings: z.array(ExternalFeedbackFindingSchema).min(1)` (an empty seed
is never written — the adapter only seeds when the extraction produced ≥1 trusted finding).
`read` returns `null` on malformed/missing (tolerant, same pattern as `readReviewArtifact`).

**Lifecycle**:
1. Adapter extracts → `writeExternalFeedbackSeed(checkoutPath, workflowId, seed)`.
2. Adapter `clearReviewArtifact(checkoutPath, workflowId)` (D-2 counter reset).
3. Phase loop enters `review` → `SeedAwareReviewExecutor.execute` reads the seed.
4. Wrapper writes the findings artifact from the seed, then
   `clearExternalFeedbackSeed(checkoutPath, workflowId)` (consume-once).
5. Subsequent convergence rounds find no seed → real `ReviewExecutor` runs.

## Mapping: FindingsArtifact synthesis (wrapper output)

The seed-aware wrapper produces the existing `FindingsArtifact` shape (owned by #1124 —
`review-artifact.ts`). It does **not** define a new artifact type.

| FindingsArtifact field    | Value when seeded                                                        |
|---------------------------|--------------------------------------------------------------------------|
| `findings[]`              | mapped from `ExternalFeedbackFinding[]` into the artifact's finding shape |
| `findings[].status`       | `'open'` (external asks are open by definition)                          |
| `findings[].severity`     | `blockingSeverity` (or higher) so `computeVerdict` yields blocking       |
| `verdict`                 | `computeVerdict(findings, blockingSeverity)` = `'changes-required'`      |
| `round`                   | `(priorRound?.round ?? 0) + 1` — after D-2 artifact-clear this is `1`    |
| `lastReviewedCommitSha`   | current HEAD (`context.github.getCurrentCommitSha()`)                    |

The severity assignment must guarantee a blocking verdict (so `remediateTrigger` fires). Using
`blockingSeverity` from the resolved review config is sufficient given `computeVerdict`'s
`SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity]` rule.

## Modified type: none externally visible

- `QueueItem.command` union is **unchanged** — the monitor still enqueues `'address-pr-feedback'`.
  Only the worker's handling of that command changes.
- `PrFeedbackMetadata` is **unchanged** (`{ prNumber, reviewThreadIds, retryAttempt? }`).

## Removed vocabulary

- `blocked:stuck-feedback-loop` label removed from
  `packages/workflow-engine/src/actions/github/label-definitions.ts` (FR-008). Any cockpit
  label-map / precedence reference must be removed or migrated in the same PR (grep at implement
  time).

## Validation rules

- Seed `version` must be exactly `1`; unknown version → treat as absent (fail-open to real
  executor), same conservatism as the review artifact reader.
- Seed is only written when extraction yields ≥1 trusted finding; a zero-finding extraction writes
  no seed and clears no artifact (nothing to remediate).
- Engine-exclusion predicate operates on **raw comment body strings** — pass `comment.body`
  unmodified to `commentCarriesEngineAuthoredReviewMarker` (the helper owns the match rule).
