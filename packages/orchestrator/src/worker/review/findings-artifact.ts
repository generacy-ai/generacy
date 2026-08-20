// #1124 seam
//
// Minimal structural interface for the findings artifact that #1124 owns. This
// feature (#1126) reads and advances the artifact via dependency injection; it
// does not define the canonical schema. When #1124 lands, this placeholder is
// re-exported from / narrowed to #1124's type and the pure convergence
// functions never change.

export type Severity = 'minor' | 'major' | 'critical';
export type FindingStatus = 'open' | 'resolved';
export type ReviewVerdict = 'clean' | 'changes-required';

export interface ReviewFinding {
  /** stable finding id (owned by #1124) */
  id: string;
  severity: Severity;
  file: string;
  line?: number;
  title: string;
  detail: string;
  /** round the finding was first raised */
  round: number;
  /** 'open' | 'resolved' — resolved is terminal (Q1) */
  status: FindingStatus;
}

export interface FindingsArtifact {
  /** rounds completed so far; 0/absent ⇒ never reviewed */
  round: number;
  findings: ReviewFinding[];
  /** head SHA of the most recent review */
  lastReviewedSha?: string;
  /** verdict of the most recent review */
  verdict?: ReviewVerdict;
}

/**
 * Normalize a possibly-absent artifact to the canonical empty shape.
 * Absent artifact is treated as `{ round: 0, findings: [] }`.
 */
export function normalizeArtifact(artifact?: FindingsArtifact | null): FindingsArtifact {
  return artifact ?? { round: 0, findings: [] };
}

const SEVERITY_ORDER: Record<Severity, number> = {
  minor: 0,
  major: 1,
  critical: 2,
};

/**
 * Numeric severity rank for comparisons: `minor(0) < major(1) < critical(2)`.
 * "Sub-blocking" = `sev(finding) < sev(blockingSeverity)`.
 */
export function sev(severity: Severity): number {
  return SEVERITY_ORDER[severity];
}
