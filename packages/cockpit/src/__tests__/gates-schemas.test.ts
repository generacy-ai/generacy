import { describe, expect, it } from 'vitest';
import {
  GateOpenSchema,
  GateAnswerSchema,
  GateOutcomeSchema,
  MALFORMED_FIXTURES,
  VALID_ANSWER_FIXTURES,
  VALID_ACK_FIXTURES,
  VALID_FIXTURES,
  GATE_TYPES,
} from '../gates/index.js';

describe('gates wire-contract schemas', () => {
  describe('gate-open round-trip (a)', () => {
    it.each([...GATE_TYPES])('round-trips %s fixture through JSON', (gateType) => {
      const fixture = VALID_FIXTURES[gateType];
      const parsed = GateOpenSchema.parse(JSON.parse(JSON.stringify(fixture)));
      expect(parsed).toEqual(fixture);
    });
  });

  describe('gate-outcome + gate-answer fixtures parse (a2)', () => {
    it.each([...GATE_TYPES])('answer fixture %s parses', (gateType) => {
      expect(() => GateAnswerSchema.parse(VALID_ANSWER_FIXTURES[gateType])).not.toThrow();
    });

    it.each(['applied', 'superseded', 'failed'] as const)('outcome fixture %s parses', (k) => {
      expect(() => GateOutcomeSchema.parse(VALID_ACK_FIXTURES[k])).not.toThrow();
    });
  });

  describe('malformed rejection (b)', () => {
    it('wrong-type-literal rejects and names type', () => {
      const r = GateOpenSchema.safeParse(MALFORMED_FIXTURES['wrong-type-literal']);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => i.path.includes('type'))).toBe(true);
    });

    it('option-missing-id rejects', () => {
      expect(() => GateOpenSchema.parse(MALFORMED_FIXTURES['option-missing-id'])).toThrow();
    });

    it('empty-gate-id rejects', () => {
      expect(() => GateOpenSchema.parse(MALFORMED_FIXTURES['empty-gate-id'])).toThrow();
    });

    it('wrong-length-gate-id rejects', () => {
      expect(() => GateOpenSchema.parse(MALFORMED_FIXTURES['wrong-length-gate-id'])).toThrow();
    });

    it('unknown-gate-type rejects', () => {
      expect(() => GateOpenSchema.parse(MALFORMED_FIXTURES['unknown-gate-type'])).toThrow();
    });

    it('invalid-issue-url rejects', () => {
      expect(() => GateOpenSchema.parse(MALFORMED_FIXTURES['invalid-issue-url'])).toThrow();
    });

    it('record-missing-title rejects and names title', () => {
      expect(() => GateOpenSchema.parse(MALFORMED_FIXTURES['record-missing-title'])).toThrow(
        /title/,
      );
    });
  });

  describe('allowFreeText is a plain boolean (c)', () => {
    it('allowFreeText:false is ACCEPTED (frozen contract: z.boolean, not literal true)', () => {
      const ok = { ...VALID_FIXTURES.clarification, allowFreeText: false };
      expect(() => GateOpenSchema.parse(ok)).not.toThrow();
    });

    it('allow-free-text-non-boolean rejects and names allowFreeText', () => {
      expect(() =>
        GateOpenSchema.parse(MALFORMED_FIXTURES['allow-free-text-non-boolean']),
      ).toThrow(/allowFreeText/);
    });
  });

  describe('gate-answer does NOT tighten optionId/freeText (d)', () => {
    it('optionId=null with null freeText is accepted (no XOR refine)', () => {
      const answer = { ...VALID_ANSWER_FIXTURES.clarification, optionId: null, freeText: null };
      expect(() => GateAnswerSchema.parse(answer)).not.toThrow();
    });

    it('optionId set with null freeText passes', () => {
      const answer = VALID_ANSWER_FIXTURES.clarification;
      expect(answer.optionId).not.toBeNull();
      expect(answer.freeText).toBeNull();
      expect(() => GateAnswerSchema.parse(answer)).not.toThrow();
    });

    it('answer-invalid-email rejects', () => {
      expect(() => GateAnswerSchema.parse(MALFORMED_FIXTURES['answer-invalid-email'])).toThrow();
    });

    it('answer-wrong-type-literal rejects', () => {
      expect(() =>
        GateAnswerSchema.parse(MALFORMED_FIXTURES['answer-wrong-type-literal']),
      ).toThrow();
    });
  });

  describe('datetime (e)', () => {
    it('rejects a naive Date.toString() timestamp on askedAt', () => {
      expect(() => GateOpenSchema.parse(MALFORMED_FIXTURES['naive-timestamp'])).toThrow(/askedAt/);
    });

    it('accepts a new Date().toISOString() timestamp', () => {
      const fixture = VALID_FIXTURES.clarification;
      const withNow = { ...fixture, askedAt: new Date().toISOString() };
      expect(() => GateOpenSchema.parse(withNow)).not.toThrow();
    });
  });

  describe('unknown fields are stripped, not rejected (f)', () => {
    it('additive fields do not throw (plain z.object, not .strict())', () => {
      const fixture = VALID_FIXTURES.clarification;
      const extended = { ...fixture, futureField: 'harmless' };
      expect(() => GateOpenSchema.parse(extended)).not.toThrow();
    });
  });

  // #1066 — optional frameId, preserved end-to-end for cloud per-frame reply
  // correlation. Same shape on both gate-open and gate-outcome: non-empty
  // string kept; omitted stays omitted; "" normalized to absent; non-string
  // rejected. See services/api/src/services/relay/message-handler.ts:804.
  describe('frameId', () => {
    const outcomeBase = VALID_ACK_FIXTURES.applied;

    describe('GateOpenSchema', () => {
      it('non-empty string is preserved on parsed object', () => {
        const fixture = VALID_FIXTURES.clarification;
        const parsed = GateOpenSchema.parse({ ...fixture, frameId: 'frm_abc' });
        expect(parsed.frameId).toBe('frm_abc');
      });

      it('omitted → absent on parsed object (wire-level)', () => {
        const fixture = VALID_FIXTURES.clarification;
        const parsed = GateOpenSchema.parse(fixture);
        expect(parsed.frameId).toBeUndefined();
        // JSON round-trip strips `undefined` — this is what the cloud sees.
        const wire = JSON.parse(JSON.stringify(parsed));
        expect(Object.hasOwn(wire, 'frameId')).toBe(false);
      });

      it.each([
        ['empty string', ''],
        ['null', null],
      ] as const)(
        '%s is normalized to absent (wire-level)',
        (_label, value) => {
          const fixture = VALID_FIXTURES.clarification;
          const parsed = GateOpenSchema.parse({ ...fixture, frameId: value });
          expect(parsed.frameId).toBeUndefined();
          const wire = JSON.parse(JSON.stringify(parsed));
          expect(Object.hasOwn(wire, 'frameId')).toBe(false);
        },
      );

      it.each([
        ['number', 123],
        ['object', {}],
        ['array', []],
      ] as const)('non-string (%s) is rejected', (_label, value) => {
        const fixture = VALID_FIXTURES.clarification;
        const r = GateOpenSchema.safeParse({ ...fixture, frameId: value });
        expect(r.success).toBe(false);
      });
    });

    describe('GateOutcomeSchema', () => {
      it('non-empty string is preserved on parsed object', () => {
        const parsed = GateOutcomeSchema.parse({ ...outcomeBase, frameId: 'frm_xyz' });
        expect(parsed.frameId).toBe('frm_xyz');
      });

      it('omitted → absent on parsed object (wire-level)', () => {
        const parsed = GateOutcomeSchema.parse(outcomeBase);
        expect(parsed.frameId).toBeUndefined();
        const wire = JSON.parse(JSON.stringify(parsed));
        expect(Object.hasOwn(wire, 'frameId')).toBe(false);
      });

      it.each([
        ['empty string', ''],
        ['null', null],
      ] as const)(
        '%s is normalized to absent (wire-level)',
        (_label, value) => {
          const parsed = GateOutcomeSchema.parse({ ...outcomeBase, frameId: value });
          expect(parsed.frameId).toBeUndefined();
          const wire = JSON.parse(JSON.stringify(parsed));
          expect(Object.hasOwn(wire, 'frameId')).toBe(false);
        },
      );

      it.each([
        ['number', 123],
        ['object', {}],
        ['array', []],
      ] as const)('non-string (%s) is rejected', (_label, value) => {
        const r = GateOutcomeSchema.safeParse({ ...outcomeBase, frameId: value });
        expect(r.success).toBe(false);
      });
    });
  });
});
