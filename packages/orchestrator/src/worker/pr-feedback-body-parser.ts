/**
 * Pure parser for the `<!-- generacy-cockpit:unanchored-findings -->`
 * marker block in a PR review body (#1047).
 *
 * Contract: `specs/1047-problem-orchestrator-s-pr/contracts/unanchored-block-parse.md`.
 * Fail-open per FR-005: absent marker or missing `**Files:**` line degrades
 * to a shape that contributes zero constraints to the FR-003 gate.
 */
import type { Review } from '@generacy-ai/workflow-engine';

const MARKER = '<!-- generacy-cockpit:unanchored-findings -->';
const FINDING_HEADING_RE = /^### Finding \d+\s*$/m;
const FILES_LINE_RE = /^\*\*Files:\*\*[ \t]*(.*)$/m;

export interface ParsedFinding {
  /** 1-based ordinal within the review body's finding list. */
  index: number;
  /** Paths named on the `**Files:**` line under this finding. */
  files: string[];
  /** True when the `**Files:**` line was present under this finding. */
  hasFilesLine: boolean;
}

export interface ParsedReview {
  reviewId: number;
  reviewer: string;
  submittedAt: string;
  findings: ParsedFinding[];
}

export function parseReviewBody(review: Review): ParsedReview {
  const base: Omit<ParsedReview, 'findings'> = {
    reviewId: review.id,
    reviewer: review.user.login,
    submittedAt: review.submittedAt,
  };

  const body = review.body ?? '';
  const markerAt = body.indexOf(MARKER);
  if (markerAt < 0) return { ...base, findings: [] };

  const section = body.slice(markerAt + MARKER.length);
  const chunks = splitOnFindingHeadings(section);
  const findings: ParsedFinding[] = chunks.map((chunk, i) => {
    const match = chunk.match(FILES_LINE_RE);
    if (!match) return { index: i + 1, files: [], hasFilesLine: false };
    const files = match[1]!
      .split(',')
      .map(f => f.trim())
      .filter(f => f.length > 0);
    return { index: i + 1, files, hasFilesLine: true };
  });

  return { ...base, findings };
}

function splitOnFindingHeadings(section: string): string[] {
  const lines = section.split('\n');
  const chunks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (FINDING_HEADING_RE.test(line)) {
      if (current !== null) chunks.push(current.join('\n'));
      current = [];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) chunks.push(current.join('\n'));
  return chunks;
}
