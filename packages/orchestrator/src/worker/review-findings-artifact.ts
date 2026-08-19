/**
 * Findings artifact — the consuming contract for #1124's review executor (#1125 T010).
 *
 * NOTE: temporary local copy. Swap to an import from @generacy-ai/workflow-engine
 * once #1124 lands the canonical type, then delete this file. See data-model.md §1.
 */
import { z } from 'zod';

export type FindingSeverity = 'blocking' | 'advisory';
export type ReviewVerdict = 'clean' | 'changes-required';

export interface FindingAnchor {
  /** Repo-relative path. */
  file: string;
  /** 1-based line in the file's post-change (RIGHT) side. */
  line: number;
}

export interface ReviewFinding {
  /**
   * Stable per-finding marker/ID; embedded in the inline comment body for
   * cross-round thread matching (FR-003/FR-009). Non-empty.
   */
  marker: string;
  /** Human-readable finding text rendered in the comment/body. */
  text: string;
  /** 'advisory' rendered visually distinct from 'blocking' (FR-004). */
  severity: FindingSeverity;
  /** Absent → body-only (no diffable anchor). */
  anchor?: FindingAnchor;
  /** Present on re-review rounds (≥ 2); true → resolve its thread (FR-009). */
  resolved?: boolean;
}

export interface FindingsArtifact {
  /** Sole driver of mark-ready/stay-draft (FR-005, [Q5→A]); never re-derived. */
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
}

export const FindingAnchorSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
});

export const ReviewFindingSchema = z.object({
  marker: z.string().min(1),
  text: z.string(),
  severity: z.enum(['blocking', 'advisory']),
  anchor: FindingAnchorSchema.optional(),
  resolved: z.boolean().optional(),
});

export const FindingsArtifactSchema = z.object({
  verdict: z.enum(['clean', 'changes-required']),
  findings: z.array(ReviewFindingSchema),
});
