import { describe, it, expect } from 'vitest';
import {
  CLARIFICATION_QUESTION_MARKERS,
  commentCarriesQuestionMarker,
  matchClarificationQuestionMarker,
} from '../clarification-markers.js';

describe('CLARIFICATION_QUESTION_MARKERS', () => {
  it('exposes the four documented dialects in declared order', () => {
    expect([...CLARIFICATION_QUESTION_MARKERS]).toEqual([
      '<!-- generacy-stage:clarification',
      '<!-- generacy-clarifications:',
      '<!-- generacy-clarification:',
      '<!-- generacy-cockpit:clarifications-batch:',
    ]);
  });
});

describe('commentCarriesQuestionMarker', () => {
  it.each(CLARIFICATION_QUESTION_MARKERS.map((m) => [m]))(
    'returns true for dialect %s at column 0',
    (prefix) => {
      expect(commentCarriesQuestionMarker(`${prefix} -->\n### Q1: Topic`)).toBe(true);
    },
  );

  it('returns true for the -batch-1 suffix variant (prefix-substring rule, SC-001 root cause)', () => {
    const body = '<!-- generacy-stage:clarification-batch-1 -->\n\n## ❓ Clarification Questions — Batch 1\n\n### Q1: Topic\nProse';
    expect(commentCarriesQuestionMarker(body)).toBe(true);
  });

  it('returns false for an unrelated marker family', () => {
    expect(commentCarriesQuestionMarker('<!-- generacy-untrusted-answer:5 -->')).toBe(false);
  });

  it('returns false for a > block-quoted marker (US4 / column-0 rule)', () => {
    const body = '> <!-- generacy-stage:clarification -->\n\nQ1: A\nQ2: B';
    expect(commentCarriesQuestionMarker(body)).toBe(false);
  });

  it('returns false when the marker has leading whitespace', () => {
    expect(commentCarriesQuestionMarker('  <!-- generacy-stage:clarification -->')).toBe(false);
    expect(commentCarriesQuestionMarker('\t<!-- generacy-stage:clarification -->')).toBe(false);
  });

  it('returns true when the marker appears on a non-first line', () => {
    const body = 'preamble text\n<!-- generacy-clarifications:42 -->\nrest';
    expect(commentCarriesQuestionMarker(body)).toBe(true);
  });

  it('returns false for empty body', () => {
    expect(commentCarriesQuestionMarker('')).toBe(false);
  });

  it('returns false for body without any marker', () => {
    expect(commentCarriesQuestionMarker('hello world\nQ1: A\nQ2: B')).toBe(false);
  });

  it('returns false when a different generacy-stage substring appears without the :clarification suffix', () => {
    expect(commentCarriesQuestionMarker('<!-- generacy-stage:specification -->')).toBe(false);
  });
});

describe('matchClarificationQuestionMarker', () => {
  it.each(CLARIFICATION_QUESTION_MARKERS.map((m) => [m]))(
    'returns the exact prefix for dialect %s',
    (prefix) => {
      const returned = matchClarificationQuestionMarker(`${prefix} -->\n### Q1: Topic`);
      expect(returned).toBe(prefix);
      // Identity from the const array (not a copy).
      expect(CLARIFICATION_QUESTION_MARKERS.indexOf(returned!)).toBeGreaterThanOrEqual(0);
    },
  );

  it('returns undefined for empty body', () => {
    expect(matchClarificationQuestionMarker('')).toBeUndefined();
  });

  it('returns undefined for a body with no marker', () => {
    expect(matchClarificationQuestionMarker('Q1: A\nQ2: B')).toBeUndefined();
  });

  it('returns undefined for a > block-quoted marker', () => {
    expect(
      matchClarificationQuestionMarker('> <!-- generacy-stage:clarification -->\n\nQ1: A'),
    ).toBeUndefined();
  });

  it('returns the first-encountered prefix when multiple lines carry markers', () => {
    const body =
      '<!-- generacy-clarifications:42 -->\n<!-- generacy-stage:clarification -->\n### Q1: Topic';
    expect(matchClarificationQuestionMarker(body)).toBe('<!-- generacy-clarifications:');
  });
});
