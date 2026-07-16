import { describe, it, expect } from 'vitest';
import {
  formatClarificationAnswerComment,
  type ClarificationAnswerMarker,
} from '../clarification-answer-marker.js';
import {
  commentCarriesAnswerMarker,
  matchClarificationAnswerMarker,
} from '@generacy-ai/orchestrator';

const validTs = '2026-07-16T12:00:00.000Z';

describe('#958 formatClarificationAnswerComment — happy path', () => {
  it('renders header line matched by commentCarriesAnswerMarker (round-trip)', () => {
    const marker: ClarificationAnswerMarker = {
      batch: 1,
      answers: { 1: 'A', 2: 'B' },
      actor: 'chris',
      ts: validTs,
    };
    const out = formatClarificationAnswerComment(marker);
    expect(commentCarriesAnswerMarker(out)).toBe(true);
    expect(matchClarificationAnswerMarker(out)).toBe(
      '<!-- generacy-clarification-answers:',
    );
  });

  it('renders header + body in the shape declared by contracts/answer-marker.md', () => {
    const out = formatClarificationAnswerComment({
      batch: 3,
      answers: { 1: 'A', 2: 'B' },
      actor: 'chris',
      ts: validTs,
    });
    expect(out).toBe(
      `<!-- generacy-clarification-answers:3 actor=chris ts=${validTs} -->\n\n` +
        '## Answers — batch 3\n\n' +
        'Q1: A\n' +
        'Q2: B\n',
    );
  });

  it('omits actor= attribute when actor is undefined', () => {
    const out = formatClarificationAnswerComment({
      batch: 0,
      answers: { 1: 'A' },
      ts: validTs,
    });
    expect(out.startsWith(`<!-- generacy-clarification-answers:0 ts=${validTs} -->`)).toBe(true);
    expect(out).not.toContain('actor=');
  });

  it("treats actor: '' the same as undefined", () => {
    const out = formatClarificationAnswerComment({
      batch: 2,
      answers: { 1: 'A' },
      actor: '',
      ts: validTs,
    });
    expect(out).not.toContain('actor=');
  });

  it('emits answer keys in ascending numeric order regardless of insertion order', () => {
    const out = formatClarificationAnswerComment({
      batch: 1,
      answers: { 3: 'C', 1: 'A', 2: 'B' },
      ts: validTs,
    });
    const lines = out.split('\n');
    const qLines = lines.filter((l) => /^Q\d+:/.test(l));
    expect(qLines).toEqual(['Q1: A', 'Q2: B', 'Q3: C']);
  });
});

describe('#958 formatClarificationAnswerComment — validation', () => {
  it('rejects non-integer batch', () => {
    expect(() =>
      formatClarificationAnswerComment({
        batch: 1.5,
        answers: { 1: 'A' },
        ts: validTs,
      }),
    ).toThrow(/batch must be a non-negative integer/);
  });

  it('rejects negative batch', () => {
    expect(() =>
      formatClarificationAnswerComment({
        batch: -1,
        answers: { 1: 'A' },
        ts: validTs,
      }),
    ).toThrow(/batch must be a non-negative integer/);
  });

  it('rejects invalid actor login', () => {
    expect(() =>
      formatClarificationAnswerComment({
        batch: 1,
        answers: { 1: 'A' },
        actor: 'invalid space',
        ts: validTs,
      }),
    ).toThrow(/invalid actor login/);
    expect(() =>
      formatClarificationAnswerComment({
        batch: 1,
        answers: { 1: 'A' },
        actor: 'a/b',
        ts: validTs,
      }),
    ).toThrow(/invalid actor login/);
  });

  it('rejects non round-trip ISO-8601 ts', () => {
    expect(() =>
      formatClarificationAnswerComment({
        batch: 1,
        answers: { 1: 'A' },
        ts: 'not-a-date',
      }),
    ).toThrow(/not round-trip ISO-8601/);
    expect(() =>
      formatClarificationAnswerComment({
        batch: 1,
        answers: { 1: 'A' },
        ts: '2026-06-26 12:00:00',
      }),
    ).toThrow(/not round-trip ISO-8601/);
  });

  it('rejects empty answers map', () => {
    expect(() =>
      formatClarificationAnswerComment({
        batch: 1,
        answers: {},
        ts: validTs,
      }),
    ).toThrow(/answers map is empty/);
  });

  it('rejects empty answer value', () => {
    expect(() =>
      formatClarificationAnswerComment({
        batch: 1,
        answers: { 1: 'A', 2: '' },
        ts: validTs,
      }),
    ).toThrow(/answer for Q2 is empty/);
  });

  it('rejects non-positive-integer answer key', () => {
    expect(() =>
      formatClarificationAnswerComment({
        batch: 1,
        answers: { 0: 'A' },
        ts: validTs,
      }),
    ).toThrow(/answer key "0" is not a positive integer/);
  });
});
