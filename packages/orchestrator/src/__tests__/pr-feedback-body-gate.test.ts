import { describe, it, expect } from 'vitest';
import type { ParsedFinding, ParsedReview } from '../worker/pr-feedback-body-parser.js';
import { evaluateBodyGate } from '../worker/pr-feedback-body-gate.js';

function finding(index: number, files: string[], hasFilesLine = true): ParsedFinding {
  return { index, files, hasFilesLine };
}

function review(overrides: Partial<ParsedReview> = {}): ParsedReview {
  return {
    reviewId: 1,
    reviewer: 'bot',
    submittedAt: '2026-07-26T10:00:00Z',
    findings: [],
    ...overrides,
  };
}

describe('evaluateBodyGate', () => {
  it('(a) empty parsedReviews → { satisfied: true }', () => {
    const result = evaluateBodyGate({
      parsedReviews: [],
      commitTouchedFiles: new Set(),
      acknowledged: new Set(),
    });
    expect(result).toEqual({ satisfied: true });
  });

  it('(b) per-author newest — same author, two submissions: only newest gates', () => {
    const older = review({
      reviewId: 1,
      reviewer: 'bot',
      submittedAt: '2026-07-26T10:00:00Z',
      findings: [finding(1, ['old.md'])],
    });
    const newer = review({
      reviewId: 2,
      reviewer: 'bot',
      submittedAt: '2026-07-26T11:00:00Z',
      findings: [finding(1, ['new.md'])],
    });
    // Touch only the older review's file. Because older is superseded, gate is unsatisfied on the newer.
    const result = evaluateBodyGate({
      parsedReviews: [older, newer],
      commitTouchedFiles: new Set(['old.md']),
      acknowledged: new Set(),
    });
    expect(result).toEqual({
      satisfied: false,
      unaddressed: [
        { reviewer: 'bot', reviewId: 2, findingIndex: 1, namedFiles: ['new.md'] },
      ],
    });
  });

  it('(c) cross-author non-supersession — reviewer A stays gating when reviewer B posts newer (Q3 regression)', () => {
    const a = review({
      reviewId: 100,
      reviewer: 'alice',
      submittedAt: '2026-07-26T10:00:00Z',
      findings: [finding(1, ['a.md'])],
    });
    const b = review({
      reviewId: 200,
      reviewer: 'bob',
      submittedAt: '2026-07-26T12:00:00Z',
      findings: [finding(1, ['b.md'])],
    });
    // Touch only b.md; alice's finding still gates.
    const result = evaluateBodyGate({
      parsedReviews: [a, b],
      commitTouchedFiles: new Set(['b.md']),
      acknowledged: new Set(),
    });
    expect(result).toEqual({
      satisfied: false,
      unaddressed: [
        { reviewer: 'alice', reviewId: 100, findingIndex: 1, namedFiles: ['a.md'] },
      ],
    });
  });

  it('(d) per-finding AND — review with findings (A, B, C), commits touch only A → unaddressed [B, C] (SC-003 regression)', () => {
    const r = review({
      reviewer: 'bot',
      reviewId: 42,
      findings: [
        finding(1, ['A.md']),
        finding(2, ['B.md']),
        finding(3, ['C.md']),
      ],
    });
    const result = evaluateBodyGate({
      parsedReviews: [r],
      commitTouchedFiles: new Set(['A.md']),
      acknowledged: new Set(),
    });
    expect(result).toEqual({
      satisfied: false,
      unaddressed: [
        { reviewer: 'bot', reviewId: 42, findingIndex: 2, namedFiles: ['B.md'] },
        { reviewer: 'bot', reviewId: 42, findingIndex: 3, namedFiles: ['C.md'] },
      ],
    });
  });

  it('(e) hasFilesLine: false contributes zero constraints (FR-005)', () => {
    const r = review({
      reviewer: 'bot',
      reviewId: 5,
      findings: [
        finding(1, [], false), // no Files line
        finding(2, ['gates.md'], true),
      ],
    });
    // Touch gates.md → only finding 2 was gating and it's satisfied → overall satisfied.
    const result = evaluateBodyGate({
      parsedReviews: [r],
      commitTouchedFiles: new Set(['gates.md']),
      acknowledged: new Set(),
    });
    expect(result).toEqual({ satisfied: true });
  });

  it('(f) ack-set exclusion — finding in acknowledged does not gate', () => {
    const r = review({
      reviewer: 'bot',
      reviewId: 77,
      findings: [
        finding(1, ['acked.md']),
        finding(2, ['open.md']),
      ],
    });
    const result = evaluateBodyGate({
      parsedReviews: [r],
      commitTouchedFiles: new Set(['open.md']), // acked.md not touched, but acknowledged
      acknowledged: new Set(['bot:77:1']),
    });
    expect(result).toEqual({ satisfied: true });
  });

  it('(g) namedFiles in unaddressed is non-empty by construction', () => {
    const r = review({
      reviewer: 'bot',
      reviewId: 8,
      findings: [finding(1, ['x.md', 'y.md'])],
    });
    const result = evaluateBodyGate({
      parsedReviews: [r],
      commitTouchedFiles: new Set(),
      acknowledged: new Set(),
    });
    if (result.satisfied) throw new Error('expected unsatisfied');
    expect(result.unaddressed).toHaveLength(1);
    expect(result.unaddressed[0]!.namedFiles.length).toBeGreaterThan(0);
    expect(result.unaddressed[0]!.namedFiles).toEqual(['x.md', 'y.md']);
  });

  it('finding with any one named file touched is satisfied', () => {
    const r = review({
      reviewer: 'bot',
      reviewId: 9,
      findings: [finding(1, ['a.md', 'b.md', 'c.md'])],
    });
    const result = evaluateBodyGate({
      parsedReviews: [r],
      commitTouchedFiles: new Set(['b.md']),
      acknowledged: new Set(),
    });
    expect(result).toEqual({ satisfied: true });
  });

  it('all findings filtered out by hasFilesLine=false → satisfied trivially', () => {
    const r = review({
      findings: [finding(1, [], false), finding(2, [], false)],
    });
    const result = evaluateBodyGate({
      parsedReviews: [r],
      commitTouchedFiles: new Set(),
      acknowledged: new Set(),
    });
    expect(result).toEqual({ satisfied: true });
  });
});
