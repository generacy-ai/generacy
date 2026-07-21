import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  GateOpenSchema,
  GateAckSchema,
  GateAnswerSchema,
} from '../schema.js';

const canonicalOpen = {
  kind: 'gate-open',
  gateId: 'g_smoke_001',
  generation: 0,
  scope: {
    owner: 'generacy-ai',
    repo: 'generacy',
    issueNumber: 1021,
  },
  openedAt: '2026-07-21T15:04:05.123Z',
  payload: { question: 'proceed?' },
};

const canonicalAck = {
  kind: 'gate-ack',
  gateId: 'g_smoke_001',
  generation: 0,
  outcome: 'answered',
  ackedAt: '2026-07-21T15:04:11.900Z',
  answer: { choice: 'proceed' },
};

const canonicalAnswer = {
  kind: 'gate-answer',
  deliveryId: 'dlv_smoke_001',
  gateId: 'g_smoke_001',
  generation: 0,
  answeredAt: '2026-07-21T15:04:11.100Z',
  answer: { choice: 'proceed' },
};

describe('GateOpenSchema', () => {
  it('parses a canonical wire example', () => {
    expect(() => GateOpenSchema.parse(canonicalOpen)).not.toThrow();
  });

  it('preserves passthrough fields', () => {
    const parsed = GateOpenSchema.parse({
      ...canonicalOpen,
      extraFutureField: 'kept',
      payload: { deep: { nested: true } },
    });
    expect((parsed as Record<string, unknown>).extraFutureField).toBe('kept');
    expect(parsed.payload).toEqual({ deep: { nested: true } });
  });

  it('rejects missing required fields', () => {
    const { gateId: _gateId, ...withoutGateId } = canonicalOpen;
    void _gateId;
    const result = GateOpenSchema.safeParse(withoutGateId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('gateId'))).toBe(
        true,
      );
    }
  });

  it('rejects wrong discriminator literal', () => {
    const result = GateOpenSchema.safeParse({
      ...canonicalOpen,
      kind: 'gate-ack',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      expect(result.error.issues.some((i) => i.path.includes('kind'))).toBe(
        true,
      );
    }
  });

  it('rejects empty gateId', () => {
    const result = GateOpenSchema.safeParse({ ...canonicalOpen, gateId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer generation', () => {
    const result = GateOpenSchema.safeParse({
      ...canonicalOpen,
      generation: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative generation', () => {
    const result = GateOpenSchema.safeParse({
      ...canonicalOpen,
      generation: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-ISO8601 openedAt', () => {
    const result = GateOpenSchema.safeParse({
      ...canonicalOpen,
      openedAt: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('accepts scope as any object shape (passthrough)', () => {
    const parsed = GateOpenSchema.parse({
      ...canonicalOpen,
      scope: { anythingGoes: true },
    });
    expect(parsed.scope).toEqual({ anythingGoes: true });
  });
});

describe('GateAckSchema', () => {
  it('parses a canonical wire example', () => {
    expect(() => GateAckSchema.parse(canonicalAck)).not.toThrow();
  });

  it('preserves passthrough fields (answer)', () => {
    const parsed = GateAckSchema.parse({
      ...canonicalAck,
      answer: { operator: 'yes', metadata: { ts: 1 } },
    });
    expect(parsed.answer).toEqual({ operator: 'yes', metadata: { ts: 1 } });
  });

  it('rejects missing outcome', () => {
    const { outcome: _outcome, ...withoutOutcome } = canonicalAck;
    void _outcome;
    const result = GateAckSchema.safeParse(withoutOutcome);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('outcome'))).toBe(
        true,
      );
    }
  });

  it('rejects empty outcome', () => {
    const result = GateAckSchema.safeParse({ ...canonicalAck, outcome: '' });
    expect(result.success).toBe(false);
  });

  it('rejects wrong kind literal', () => {
    const result = GateAckSchema.safeParse({
      ...canonicalAck,
      kind: 'gate-open',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty gateId', () => {
    const result = GateAckSchema.safeParse({ ...canonicalAck, gateId: '' });
    expect(result.success).toBe(false);
  });
});

describe('GateAnswerSchema', () => {
  it('parses a canonical wire example', () => {
    expect(() => GateAnswerSchema.parse(canonicalAnswer)).not.toThrow();
  });

  it('preserves passthrough fields', () => {
    const parsed = GateAnswerSchema.parse({
      ...canonicalAnswer,
      extra: 'kept',
    });
    expect((parsed as Record<string, unknown>).extra).toBe('kept');
  });

  it('rejects missing deliveryId', () => {
    const { deliveryId: _deliveryId, ...withoutDeliveryId } = canonicalAnswer;
    void _deliveryId;
    const result = GateAnswerSchema.safeParse(withoutDeliveryId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.includes('deliveryId')),
      ).toBe(true);
    }
  });

  it('rejects empty deliveryId', () => {
    const result = GateAnswerSchema.safeParse({
      ...canonicalAnswer,
      deliveryId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects wrong kind literal', () => {
    const result = GateAnswerSchema.safeParse({
      ...canonicalAnswer,
      kind: 'gate-open',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-ISO8601 answeredAt', () => {
    const result = GateAnswerSchema.safeParse({
      ...canonicalAnswer,
      answeredAt: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('accepts answer field of any type', () => {
    expect(() =>
      GateAnswerSchema.parse({ ...canonicalAnswer, answer: 'string' }),
    ).not.toThrow();
    expect(() =>
      GateAnswerSchema.parse({ ...canonicalAnswer, answer: 42 }),
    ).not.toThrow();
    expect(() =>
      GateAnswerSchema.parse({ ...canonicalAnswer, answer: null }),
    ).not.toThrow();
  });
});
