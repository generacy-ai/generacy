import { describe, it, expect } from 'vitest';
import type { Review } from '@generacy-ai/workflow-engine';
import { parseReviewBody } from '../worker/pr-feedback-body-parser.js';

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: 1,
    user: { login: 'bot' },
    body: '',
    state: 'COMMENTED',
    submittedAt: '2026-07-26T10:00:00Z',
    ...overrides,
  };
}

describe('parseReviewBody', () => {
  it('(a) absent marker → empty findings', () => {
    const result = parseReviewBody(
      makeReview({
        body:
          "This PR is looking good but there's a stale contract at auto.md:28 that needs updating.",
      }),
    );
    expect(result.findings).toEqual([]);
    expect(result.reviewId).toBe(1);
    expect(result.reviewer).toBe('bot');
    expect(result.submittedAt).toBe('2026-07-26T10:00:00Z');
  });

  it('(b) marker present, zero `### Finding` sub-headings → empty findings', () => {
    const result = parseReviewBody(
      makeReview({
        body: 'Summary.\n\n<!-- generacy-cockpit:unanchored-findings -->\n\nSome prose but no headings.',
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it('(c) marker present, single finding with **Files:** → hasFilesLine=true, correct paths', () => {
    const body = `Summary.

<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Finding:** Stale contract description

**Files:** packages/claude-plugin-cockpit/commands/auto.md`;
    const result = parseReviewBody(makeReview({ body }));
    expect(result.findings).toEqual([
      {
        index: 1,
        files: ['packages/claude-plugin-cockpit/commands/auto.md'],
        hasFilesLine: true,
      },
    ]);
  });

  it('(d) marker present, single finding WITHOUT **Files:** → hasFilesLine=false (older-producer compat, FR-005)', () => {
    const body = `<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Finding:** X only, no files line.`;
    const result = parseReviewBody(makeReview({ body }));
    expect(result.findings).toEqual([
      { index: 1, files: [], hasFilesLine: false },
    ]);
  });

  it('(e) multi-finding with mixed shapes', () => {
    const body = `<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Files:** foo.md, bar.md

### Finding 2

**Finding:** Something without a Files line.`;
    const result = parseReviewBody(makeReview({ body }));
    expect(result.findings).toEqual([
      { index: 1, files: ['foo.md', 'bar.md'], hasFilesLine: true },
      { index: 2, files: [], hasFilesLine: false },
    ]);
  });

  it('(f) **Files:** line splits on comma, trims, and drops empties', () => {
    const body = `<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Files:**   a.md ,  b.md,,c.md ,`;
    const result = parseReviewBody(makeReview({ body }));
    expect(result.findings).toEqual([
      { index: 1, files: ['a.md', 'b.md', 'c.md'], hasFilesLine: true },
    ]);
  });

  it('(g) 1-based index ordering matches heading appearance (not the number in the heading)', () => {
    // Producer may misnumber; the parser assigns index by appearance order.
    const body = `<!-- generacy-cockpit:unanchored-findings -->

### Finding 3

**Files:** first-in-appearance.md

### Finding 1

**Files:** second-in-appearance.md

### Finding 2

**Files:** third-in-appearance.md`;
    const result = parseReviewBody(makeReview({ body }));
    expect(result.findings.map(f => f.index)).toEqual([1, 2, 3]);
    expect(result.findings[0]!.files).toEqual(['first-in-appearance.md']);
    expect(result.findings[1]!.files).toEqual(['second-in-appearance.md']);
    expect(result.findings[2]!.files).toEqual(['third-in-appearance.md']);
  });

  it('empty body → empty findings', () => {
    const result = parseReviewBody(makeReview({ body: '' }));
    expect(result.findings).toEqual([]);
  });

  it('**Files:** with empty capture → files empty, hasFilesLine still true (contract § Fail-open cases)', () => {
    const body = `<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Files:** `;
    const result = parseReviewBody(makeReview({ body }));
    expect(result.findings).toEqual([
      { index: 1, files: [], hasFilesLine: true },
    ]);
  });
});
