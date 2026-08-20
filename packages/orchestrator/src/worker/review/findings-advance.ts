import type {
  FindingsArtifact,
  ReviewFinding,
  ReviewVerdict,
  Severity,
} from './findings-artifact.js';
import { sev } from './findings-artifact.js';
import type { ReviewDelta } from './review-delta.js';

export interface AdvanceInput {
  artifact: FindingsArtifact;
  delta: ReviewDelta;
  /** finding ids the reviewer reports addressed */
  reviewerAddressed: string[];
  /** raw new findings the reviewer returned */
  reviewerNewFindings: ReviewFinding[];
  blockingSeverity: Severity;
}

export interface AdvanceResult {
  /** next artifact (immutable transition) */
  artifact: FindingsArtifact;
  verdict: ReviewVerdict;
  /** filtered-out advisory findings (round ≥ 2) */
  droppedSubBlocking: ReviewFinding[];
}

/**
 * FR-005 / Q3: engine-side advisory filter, authoritative over the prompt.
 * - `round === 1` ⇒ keep all (advisory allowed on the first full review).
 * - `round >= 2` ⇒ drop any finding with `sev < sev(blockingSeverity)`.
 */
export function filterNewFindings(
  newFindings: ReviewFinding[],
  round: number,
  blockingSeverity: Severity,
): { kept: ReviewFinding[]; dropped: ReviewFinding[] } {
  if (round === 1) {
    return { kept: [...newFindings], dropped: [] };
  }
  const threshold = sev(blockingSeverity);
  const kept: ReviewFinding[] = [];
  const dropped: ReviewFinding[] = [];
  for (const f of newFindings) {
    if (sev(f.severity) >= threshold) {
      kept.push(f);
    } else {
      dropped.push(f);
    }
  }
  return { kept, dropped };
}

/**
 * FR-008: `changes-required` iff any finding at/above `blockingSeverity` is
 * still `open`; else `clean`.
 */
export function computeVerdict(
  artifact: FindingsArtifact,
  blockingSeverity: Severity,
): ReviewVerdict {
  const threshold = sev(blockingSeverity);
  const hasBlockingOpen = artifact.findings.some(
    (f) => f.status === 'open' && sev(f.severity) >= threshold,
  );
  return hasBlockingOpen ? 'changes-required' : 'clean';
}

/**
 * FR-006: monotonic status machine over the findings artifact. Returns a new
 * artifact (immutable transition).
 *
 * 1. `open` finding whose file is in `delta.files` and whose id is in
 *    `reviewerAddressed` ⇒ `resolved`.
 * 2. `open` findings not in the delta ⇒ unchanged (Q2 — evidence-based).
 * 3. `resolved` findings ⇒ never touched (Q1 — terminal).
 * 4. New findings ⇒ `filterNewFindings` first; survivors appended with
 *    `round = delta.round`.
 * 5. `lastReviewedSha = delta.base.head`; `round = delta.round`.
 * 6. `verdict = computeVerdict(nextArtifact, blockingSeverity)`.
 */
export function advanceArtifact(input: AdvanceInput): AdvanceResult {
  const { artifact, delta, reviewerAddressed, reviewerNewFindings, blockingSeverity } =
    input;

  const deltaFiles = new Set(delta.files);
  const addressed = new Set(reviewerAddressed);

  const transitioned: ReviewFinding[] = artifact.findings.map((f) => {
    if (
      f.status === 'open' &&
      deltaFiles.has(f.file) &&
      addressed.has(f.id)
    ) {
      return { ...f, status: 'resolved' as const };
    }
    // resolved stays resolved (Q1); open-outside-delta stays open (Q2).
    return f;
  });

  const { kept, dropped } = filterNewFindings(
    reviewerNewFindings,
    delta.round,
    blockingSeverity,
  );
  const appended: ReviewFinding[] = kept.map((f) => ({ ...f, round: delta.round }));

  const nextArtifact: FindingsArtifact = {
    round: delta.round,
    findings: [...transitioned, ...appended],
    lastReviewedSha: delta.base.head,
  };

  const verdict = computeVerdict(nextArtifact, blockingSeverity);
  nextArtifact.verdict = verdict;

  return { artifact: nextArtifact, verdict, droppedSubBlocking: dropped };
}
