import { describe, it, expect } from 'vitest';
import {
  computeClarificationAnswerSetHash,
  type ClarificationQuestion,
} from '../clarification-hash.js';
import { CLARIFICATION_ANSWER_SET_FIXTURES } from '../fixtures.js';

describe('computeClarificationAnswerSetHash (#1038 SC-002 canonicalization)', () => {
  it('returns a 12-character hex string', () => {
    const hash = computeClarificationAnswerSetHash(
      CLARIFICATION_ANSWER_SET_FIXTURES.singleQuestion,
    );
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(hash.length).toBe(12);
  });

  it('sort-stability — out-of-order input yields the same hash as sorted input', () => {
    const scrambled = computeClarificationAnswerSetHash(
      CLARIFICATION_ANSWER_SET_FIXTURES.threeQuestions,
    );
    const sortedInput: { questions: ClarificationQuestion[] } = {
      questions: [
        { questionNumber: 1, questionText: 'Which auth method?' },
        { questionNumber: 2, questionText: 'Which DB?' },
        { questionNumber: 3, questionText: 'Timezone?' },
      ],
    };
    const sorted = computeClarificationAnswerSetHash(sortedInput);
    expect(scrambled).toBe(sorted);
  });

  it('projection strips extra fields — richer inputs match minimal inputs', () => {
    // Minimal shape.
    const minimal = computeClarificationAnswerSetHash({
      questions: [{ questionNumber: 1, questionText: 'Which auth method?' }],
    });
    // Same two-field content but wrapped in a richer object literal — the
    // projection at step 2 of the algorithm strips everything except
    // questionNumber + questionText.
    const rich = computeClarificationAnswerSetHash({
      questions: [
        {
          questionNumber: 1,
          questionText: 'Which auth method?',
          // Fields below MUST NOT influence the hash.
          answerText: 'oauth',
          askedAt: '2026-07-23T00:00:00.000Z',
          extra: { deep: true },
        } as ClarificationQuestion & Record<string, unknown>,
      ],
    });
    expect(rich).toBe(minimal);
  });

  it('determinism — same input yields byte-identical output on N calls', () => {
    const inputs = [
      CLARIFICATION_ANSWER_SET_FIXTURES.singleQuestion,
      CLARIFICATION_ANSWER_SET_FIXTURES.threeQuestions,
      CLARIFICATION_ANSWER_SET_FIXTURES.unicode,
    ];
    for (const input of inputs) {
      const first = computeClarificationAnswerSetHash(input);
      for (let i = 0; i < 20; i++) {
        expect(computeClarificationAnswerSetHash(input)).toBe(first);
      }
    }
  });

  it('unicode — non-ASCII questionText round-trips deterministically', () => {
    const hash = computeClarificationAnswerSetHash(
      CLARIFICATION_ANSWER_SET_FIXTURES.unicode,
    );
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    // Sanity: a differently-punctuated string yields a different hash.
    const perturbed = computeClarificationAnswerSetHash({
      questions: [
        { questionNumber: 1, questionText: 'Préférence pour l’heure locale? 🌎' },
        { questionNumber: 2, questionText: '中文文本 — 数据库偏好?' },
      ],
    });
    expect(perturbed).not.toBe(hash);
  });

  it('different question sets → different hashes (basic collision-freedom sanity)', () => {
    const a = computeClarificationAnswerSetHash(
      CLARIFICATION_ANSWER_SET_FIXTURES.singleQuestion,
    );
    const b = computeClarificationAnswerSetHash(
      CLARIFICATION_ANSWER_SET_FIXTURES.threeQuestions,
    );
    const c = computeClarificationAnswerSetHash(
      CLARIFICATION_ANSWER_SET_FIXTURES.unicode,
    );
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('empty question set is a legitimate input (yields a deterministic hash)', () => {
    const hash = computeClarificationAnswerSetHash({ questions: [] });
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(hash).toBe(computeClarificationAnswerSetHash({ questions: [] }));
  });
});
