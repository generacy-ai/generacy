import type { ReviewArtifact, ReviewFinding, Severity } from '../review-artifact.js';
import { SEVERITY_RANK } from '../review-artifact.js';
import type { ReviewDelta } from './review-delta.js';

/**
 * FR-005 / Q3: engine-side advisory filter, authoritative over the prompt.
 * - `round === 1` ⇒ keep all (advisory allowed on the first full review).
 * - `round >= 2` ⇒ drop any finding below `blockingSeverity` (Decision 5).
 */
export function filterNewFindings(
  candidates: ReviewFinding[],
  round: number,
  blockingSeverity: Severity,
): ReviewFinding[] {
  if (round === 1) {
    return [...candidates];
  }
  const threshold = SEVERITY_RANK[blockingSeverity];
  return candidates.filter((f) => SEVERITY_RANK[f.severity] >= threshold);
}

/**
 * FR-006: monotonic status machine over the findings artifact. Returns the merged
 * `ReviewFinding[]`; the executor computes the verdict (via the single
 * `computeVerdict`) and writes the canonical artifact.
 *
 * 1. `open` finding whose file is in `delta.changedFiles` and whose id matches a
 *    `reviewerAddressed` finding ⇒ `resolved`.
 * 2. `open` findings not in the delta ⇒ unchanged (Q2 — evidence-based;
 *    anti-vanish carry-forward, SC-005).
 * 3. `resolved` findings ⇒ never touched (Q1 — terminal).
 * 4. New findings ⇒ `filterNewFindings` first; survivors appended with
 *    `round = delta.round`.
 */
export function advanceArtifact(
  prior: ReviewArtifact | null,
  delta: ReviewDelta,
  reviewerAddressed: ReviewFinding[],
  reviewerNewFindings: ReviewFinding[],
  blockingSeverity: Severity,
): ReviewFinding[] {
  const deltaFiles = new Set(delta.files);
  const addressed = new Set(reviewerAddressed.map((f) => f.id));

  const priorFindings = prior?.findings ?? [];
  const transitioned: ReviewFinding[] = priorFindings.map((f) => {
    if (f.status === 'open' && deltaFiles.has(f.file) && addressed.has(f.id)) {
      return { ...f, status: 'resolved' as const };
    }
    // resolved stays resolved (Q1); open-outside-delta stays open (Q2).
    return f;
  });

  const kept = filterNewFindings(reviewerNewFindings, delta.round, blockingSeverity);
  const appended: ReviewFinding[] = kept.map((f) => ({ ...f, round: delta.round }));

  return [...transitioned, ...appended];
}
