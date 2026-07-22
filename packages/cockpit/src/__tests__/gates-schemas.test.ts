import { describe, expect, it } from 'vitest';
import {
  GateRecordSchema,
  GateAnswerSchema,
  MALFORMED_FIXTURES,
  VALID_ANSWER_FIXTURES,
  VALID_FIXTURES,
  GATE_TYPES,
} from '../gates/index.js';

describe('gates wire-contract schemas', () => {
  describe('GateRecord round-trip (a)', () => {
    it.each([...GATE_TYPES])('round-trips %s fixture through JSON', (gateType) => {
      const fixture = VALID_FIXTURES[gateType];
      const parsed = GateRecordSchema.parse(JSON.parse(JSON.stringify(fixture)));
      expect(parsed).toEqual(fixture);
    });
  });

  describe('malformed rejection (b)', () => {
    it('missing-description rejects and names the offending field', () => {
      expect(() => GateRecordSchema.parse(MALFORMED_FIXTURES['missing-description'])).toThrow(
        /description/,
      );
    });

    it('empty-gate-id rejects', () => {
      expect(() => GateRecordSchema.parse(MALFORMED_FIXTURES['empty-gate-id'])).toThrow();
    });

    it('unknown-gate-type rejects', () => {
      expect(() =>
        GateRecordSchema.parse(MALFORMED_FIXTURES['unknown-gate-type']),
      ).toThrow();
    });

    it('non-hex-gate-id-prefix rejects', () => {
      expect(() =>
        GateRecordSchema.parse(MALFORMED_FIXTURES['non-hex-gate-id-prefix']),
      ).toThrow();
    });

    it('invalid-issue-url rejects', () => {
      expect(() =>
        GateRecordSchema.parse(MALFORMED_FIXTURES['invalid-issue-url']),
      ).toThrow();
    });

    it('record-missing-title rejects and names title', () => {
      expect(() =>
        GateRecordSchema.parse(MALFORMED_FIXTURES['record-missing-title']),
      ).toThrow(/title/);
    });
  });

  describe('allowFreeText invariant (c)', () => {
    it('allowFreeText:false is rejected (Q4)', () => {
      expect(() =>
        GateRecordSchema.parse(MALFORMED_FIXTURES['allow-free-text-false']),
      ).toThrow(/allowFreeText/);
    });
  });

  describe('GateAnswer refine (d)', () => {
    it('optionId=null with empty freeText fails with the exact refine message', () => {
      const result = GateAnswerSchema.safeParse(
        MALFORMED_FIXTURES['answer-null-option-empty-free-text'],
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((issue) => issue.message);
        expect(messages).toContain('optionId=null requires a non-empty freeText');
      }
    });

    it('optionId=null with a non-empty freeText passes', () => {
      const answer = VALID_ANSWER_FIXTURES['artifact-review'];
      expect(answer.optionId).toBeNull();
      expect(answer.freeText).toBeDefined();
      expect(() => GateAnswerSchema.parse(answer)).not.toThrow();
    });

    it('optionId set with no freeText passes', () => {
      const answer = VALID_ANSWER_FIXTURES.clarification;
      expect(answer.optionId).not.toBeNull();
      expect(() => GateAnswerSchema.parse(answer)).not.toThrow();
    });
  });

  describe('datetime with offset (e)', () => {
    it('rejects a naive Date.toString() timestamp', () => {
      expect(() =>
        GateRecordSchema.parse(MALFORMED_FIXTURES['naive-timestamp']),
      ).toThrow(/askedAt/);
    });

    it('accepts a new Date().toISOString() timestamp', () => {
      const fixture = VALID_FIXTURES.clarification;
      const withNow = { ...fixture, askedAt: new Date().toISOString() };
      expect(() => GateRecordSchema.parse(withNow)).not.toThrow();
    });
  });

  describe('forward-compat additive fields', () => {
    it('unknown fields pass through (schema uses plain z.object, not .strict())', () => {
      const fixture = VALID_FIXTURES.clarification;
      const extended = { ...fixture, futureField: 'harmless' };
      expect(() => GateRecordSchema.parse(extended)).not.toThrow();
    });
  });
});
