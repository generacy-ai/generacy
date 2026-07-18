import { describe, it, expect } from 'vitest';
import {
  CLARIFICATION_QUESTION_MARKERS,
  commentCarriesQuestionMarker,
  matchClarificationQuestionMarker,
  CLARIFICATION_ANSWER_MARKERS,
  commentCarriesAnswerMarker,
  matchClarificationAnswerMarker,
  MACHINE_MARKER_FAMILIES,
  commentCarriesMachineMarker,
  matchMachineMarker,
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
    // #976: the question-marker predicate stays narrow. Bot explainer /
    // stage-status / answer-relay families are covered by MACHINE_MARKERS
    // (see clarification-machine-markers.test.ts), not by this predicate.
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

describe('#958 CLARIFICATION_ANSWER_MARKERS', () => {
  it('exposes exactly one initial dialect in declared order', () => {
    expect([...CLARIFICATION_ANSWER_MARKERS]).toEqual([
      '<!-- generacy-clarification-answers:',
    ]);
  });
});

describe('#958 commentCarriesAnswerMarker', () => {
  it('returns true when the marker appears at column 0', () => {
    const body = '<!-- generacy-clarification-answers:1 actor=chris ts=2026-07-16T00:00:00Z -->\n\nQ1: A';
    expect(commentCarriesAnswerMarker(body)).toBe(true);
  });

  it('returns false when the marker is > block-quoted (column-0 rule)', () => {
    const body = '> <!-- generacy-clarification-answers:1 -->\n\nQ1: A';
    expect(commentCarriesAnswerMarker(body)).toBe(false);
  });

  it('returns false for a question-family marker (non-overlap)', () => {
    expect(commentCarriesAnswerMarker('<!-- generacy-clarifications:42 -->')).toBe(false);
    expect(commentCarriesAnswerMarker('<!-- generacy-clarification:1 -->')).toBe(false);
    expect(commentCarriesAnswerMarker('<!-- generacy-stage:clarification -->')).toBe(false);
    expect(commentCarriesAnswerMarker('<!-- generacy-cockpit:clarifications-batch:1 -->')).toBe(false);
  });

  it('returns false when the marker has leading whitespace', () => {
    expect(commentCarriesAnswerMarker('  <!-- generacy-clarification-answers:1 -->')).toBe(false);
    expect(commentCarriesAnswerMarker('\t<!-- generacy-clarification-answers:1 -->')).toBe(false);
  });

  it('returns false for empty body', () => {
    expect(commentCarriesAnswerMarker('')).toBe(false);
  });

  it('returns false for body without any marker', () => {
    expect(commentCarriesAnswerMarker('Q1: A\nQ2: B')).toBe(false);
  });

  it('returns true when the marker appears on a non-first line', () => {
    const body = 'preamble\n<!-- generacy-clarification-answers:2 -->\nQ1: A';
    expect(commentCarriesAnswerMarker(body)).toBe(true);
  });
});

describe('#993 MACHINE_MARKER_FAMILIES (SC-004)', () => {
  it('exposes the two stage families in declared order', () => {
    expect([...MACHINE_MARKER_FAMILIES]).toEqual([
      '<!-- generacy-stage:',
      '<!-- speckit-stage:',
    ]);
  });

  it('family match — speckit-stage:tasks returns family prefix', () => {
    const input = '<!-- speckit-stage:tasks -->\nBody\n';
    expect(commentCarriesMachineMarker(input)).toBe(true);
    expect(matchMachineMarker(input)).toBe('<!-- speckit-stage:');
  });

  it('family match — the observed-bug prefix speckit-stage:clarification is caught', () => {
    const input = '<!-- speckit-stage:clarification -->\n';
    expect(commentCarriesMachineMarker(input)).toBe(true);
    expect(matchMachineMarker(input)).toBe('<!-- speckit-stage:');
  });

  it('family match — previously-enumerated generacy-stage:specification still caught', () => {
    const input = '<!-- generacy-stage:specification -->\n';
    expect(commentCarriesMachineMarker(input)).toBe(true);
    expect(matchMachineMarker(input)).toBe('<!-- generacy-stage:');
  });

  it('SC-004 — unknown future stage suffix matches without a code change', () => {
    const input = '<!-- generacy-stage:future-phase-that-does-not-exist-yet -->\n';
    expect(commentCarriesMachineMarker(input)).toBe(true);
    expect(matchMachineMarker(input)).toBe('<!-- generacy-stage:');
  });

  it('anchor preserved — question-batch prefix returns enumerated (not family)', () => {
    // `<!-- generacy-clarifications:` does not begin with either family
    // prefix, so the enumerated match fires. The FR-004 anchor set stays
    // unaffected by the family refactor.
    const input = '<!-- generacy-clarifications:5 -->\n';
    expect(matchMachineMarker(input)).toBe('<!-- generacy-clarifications:');
    expect(commentCarriesQuestionMarker(input)).toBe(true);
  });

  it('case sensitivity preserved for family match', () => {
    const input = '<!-- Generacy-Stage:foo -->\n';
    expect(commentCarriesMachineMarker(input)).toBe(false);
  });

  it('`> `-quoted family marker still not matched (column-0 rule)', () => {
    const input = '> <!-- generacy-stage:specification -->\n';
    expect(commentCarriesMachineMarker(input)).toBe(false);
  });

  it('empty body returns undefined', () => {
    expect(matchMachineMarker('')).toBeUndefined();
  });
});

describe('#958 matchClarificationAnswerMarker', () => {
  it('returns the exact prefix on match', () => {
    const returned = matchClarificationAnswerMarker(
      '<!-- generacy-clarification-answers:1 -->\nQ1: A',
    );
    expect(returned).toBe('<!-- generacy-clarification-answers:');
  });

  it('returns undefined for empty body', () => {
    expect(matchClarificationAnswerMarker('')).toBeUndefined();
  });

  it('returns undefined for question-family markers', () => {
    expect(
      matchClarificationAnswerMarker('<!-- generacy-clarifications:42 -->'),
    ).toBeUndefined();
  });

  it('answer-marker family and question-marker family are disjoint', () => {
    // No member of one is a prefix of a member of the other (spec
    // contracts/answer-marker.md §Non-overlap).
    for (const answer of CLARIFICATION_ANSWER_MARKERS) {
      for (const question of CLARIFICATION_QUESTION_MARKERS) {
        expect(answer.startsWith(question)).toBe(false);
        expect(question.startsWith(answer)).toBe(false);
      }
    }
  });
});
