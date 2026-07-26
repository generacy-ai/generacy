/**
 * Pure per-finding gate evaluator for PR-feedback body findings (#1047).
 *
 * Semantics per `data-model.md § Gate-evaluator contract`
 * (FR-003 + Q3 + Q5 + Q6):
 *   1. Per-author newest — group by reviewer, keep max submittedAt.
 *   2. Filter each review's findings to `hasFilesLine === true`.
 *   3. Drop findings whose `${reviewer}:${reviewId}:${index}` key is in
 *      the acknowledgment set (FR-008).
 *   4. A finding is satisfied iff at least one path is in
 *      `commitTouchedFiles`.
 *   5. All remaining findings must be satisfied for `{satisfied: true}`.
 */
import type { AcknowledgedFindings } from './pr-feedback-ack-parser.js';
import type { ParsedReview } from './pr-feedback-body-parser.js';

export interface UnaddressedFinding {
  reviewer: string;
  reviewId: number;
  findingIndex: number;
  /** Files named on the finding. Non-empty by construction. */
  namedFiles: string[];
}

export type GateResult =
  | { satisfied: true }
  | { satisfied: false; unaddressed: UnaddressedFinding[] };

export interface EvaluateBodyGateInput {
  parsedReviews: readonly ParsedReview[];
  commitTouchedFiles: ReadonlySet<string>;
  acknowledged: AcknowledgedFindings;
}

export function evaluateBodyGate(input: EvaluateBodyGateInput): GateResult {
  const { parsedReviews, commitTouchedFiles, acknowledged } = input;

  const newestByAuthor = new Map<string, ParsedReview>();
  for (const review of parsedReviews) {
    const existing = newestByAuthor.get(review.reviewer);
    if (!existing || review.submittedAt > existing.submittedAt) {
      newestByAuthor.set(review.reviewer, review);
    }
  }

  const unaddressed: UnaddressedFinding[] = [];
  for (const review of newestByAuthor.values()) {
    for (const finding of review.findings) {
      if (!finding.hasFilesLine) continue;
      const key = `${review.reviewer}:${review.reviewId}:${finding.index}`;
      if (acknowledged.has(key)) continue;
      const satisfied = finding.files.some(f => commitTouchedFiles.has(f));
      if (satisfied) continue;
      unaddressed.push({
        reviewer: review.reviewer,
        reviewId: review.reviewId,
        findingIndex: finding.index,
        namedFiles: finding.files,
      });
    }
  }

  if (unaddressed.length === 0) return { satisfied: true };
  return { satisfied: false, unaddressed };
}
