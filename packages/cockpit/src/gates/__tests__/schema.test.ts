import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  GateOpenSchema,
  GateOutcomeSchema,
  GateAnswerSchema,
  deriveGateKey,
  deriveGateId,
} from '../schema.js';

// Canonical Shape 1 — gate-open (cluster → cloud). Flat, type-literal, string refs.
const canonicalOpen = {
  type: 'gate-open',
  gateId: deriveGateId(
    deriveGateKey('generacy-ai/generacy#1021', 'artifact-review', 'spec-review:abc1234'),
  ),
  gateKey: 'generacy-ai/generacy#1021:artifact-review:spec-review:abc1234',
  gateType: 'artifact-review',
  epicRef: 'generacy-ai/generacy#1000',
  issueRef: 'generacy-ai/generacy#1021',
  issueTitle: 'cockpit remote gates',
  issueUrl: 'https://github.com/generacy-ai/generacy/issues/1021',
  title: 'Review the spec',
  body: 'Approve the drafted spec?',
  options: [
    { id: 'approve', label: 'Approve', recommended: true },
    { id: 'changes', label: 'Request changes', description: 'Send back for edits' },
  ],
  allowFreeText: true,
  sessionId: 'sess-001',
  askedAt: '2026-07-21T15:04:05.123Z',
} as const;

// Canonical Shape 2 — gate-outcome (THE ACK).
const canonicalOutcome = {
  type: 'gate-outcome',
  gateId: canonicalOpen.gateId,
  outcome: 'applied',
  at: '2026-07-21T15:04:11.900Z',
} as const;

// Canonical Shape 3 — gate-answer (cloud → cluster, down-path).
const canonicalAnswer = {
  type: 'gate-answer',
  gateId: canonicalOpen.gateId,
  gateKey: canonicalOpen.gateKey,
  optionId: 'approve',
  freeText: null,
  actor: { userId: 'user-1', email: 'op@example.com', displayName: 'Op' },
  answeredAt: '2026-07-21T15:04:11.100Z',
  deliveryId: 'dlv-001',
} as const;

describe('GateOpenSchema (Shape 1)', () => {
  it('parses a canonical wire example', () => {
    expect(() => GateOpenSchema.parse(canonicalOpen)).not.toThrow();
  });

  it('rejects the wrong type discriminator', () => {
    const result = GateOpenSchema.safeParse({ ...canonicalOpen, type: 'gate-outcome' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      expect(result.error.issues.some((i) => i.path.includes('type'))).toBe(true);
    }
  });

  it('rejects a gateId that is not exactly 24 chars', () => {
    expect(GateOpenSchema.safeParse({ ...canonicalOpen, gateId: 'tooshort' }).success).toBe(false);
    expect(
      GateOpenSchema.safeParse({ ...canonicalOpen, gateId: canonicalOpen.gateId + 'a' }).success,
    ).toBe(false);
  });

  it('rejects an unknown gateType', () => {
    expect(GateOpenSchema.safeParse({ ...canonicalOpen, gateType: 'nope' }).success).toBe(false);
  });

  it('requires allowFreeText to be a boolean', () => {
    expect(GateOpenSchema.safeParse({ ...canonicalOpen, allowFreeText: 'yes' }).success).toBe(false);
    // both boolean values are accepted (not pinned to true).
    expect(GateOpenSchema.safeParse({ ...canonicalOpen, allowFreeText: false }).success).toBe(true);
  });

  it('option description is optional', () => {
    const parsed = GateOpenSchema.parse({
      ...canonicalOpen,
      options: [{ id: 'x', label: 'X' }],
    });
    expect(parsed.options[0].description).toBeUndefined();
  });

  it('rejects an option missing its id', () => {
    expect(
      GateOpenSchema.safeParse({ ...canonicalOpen, options: [{ label: 'X' }] }).success,
    ).toBe(false);
  });

  it('requires a fully-qualified issueUrl', () => {
    expect(GateOpenSchema.safeParse({ ...canonicalOpen, issueUrl: 'generacy-ai/generacy#1021' }).success).toBe(
      false,
    );
  });

  it('rejects a naive (non-ISO-8601) askedAt', () => {
    expect(GateOpenSchema.safeParse({ ...canonicalOpen, askedAt: 'not-a-date' }).success).toBe(false);
  });

  it('rejects a non-positive prNumber', () => {
    expect(GateOpenSchema.safeParse({ ...canonicalOpen, prNumber: 0 }).success).toBe(false);
    expect(GateOpenSchema.safeParse({ ...canonicalOpen, prNumber: 42 }).success).toBe(true);
  });

  it('caps options at 20', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `o${i}`, label: `O${i}` }));
    expect(GateOpenSchema.safeParse({ ...canonicalOpen, options: many }).success).toBe(false);
  });
});

describe('GateOutcomeSchema (Shape 2 — the ACK)', () => {
  it('parses a canonical wire example', () => {
    expect(() => GateOutcomeSchema.parse(canonicalOutcome)).not.toThrow();
  });

  it('accepts each closed outcome value and an optional detail', () => {
    for (const outcome of ['applied', 'superseded', 'failed'] as const) {
      expect(GateOutcomeSchema.safeParse({ ...canonicalOutcome, outcome }).success).toBe(true);
    }
    expect(GateOutcomeSchema.safeParse({ ...canonicalOutcome, detail: 'why' }).success).toBe(true);
  });

  it('rejects an outcome outside the closed enum', () => {
    expect(GateOutcomeSchema.safeParse({ ...canonicalOutcome, outcome: 'answered' }).success).toBe(
      false,
    );
  });

  it('rejects the wrong type discriminator', () => {
    expect(GateOutcomeSchema.safeParse({ ...canonicalOutcome, type: 'gate-open' }).success).toBe(
      false,
    );
  });

  it('has no generation and uses `at` (not ackedAt)', () => {
    const parsed = GateOutcomeSchema.parse(canonicalOutcome);
    expect(parsed).not.toHaveProperty('generation');
    expect(parsed.at).toBe(canonicalOutcome.at);
  });
});

describe('GateAnswerSchema (Shape 3 — down-path)', () => {
  it('parses a canonical option answer with freeText: null', () => {
    expect(() => GateAnswerSchema.parse(canonicalAnswer)).not.toThrow();
  });

  it('accepts a pure free-text answer (optionId: null)', () => {
    expect(
      GateAnswerSchema.safeParse({ ...canonicalAnswer, optionId: null, freeText: 'do this' })
        .success,
    ).toBe(true);
  });

  it('does NOT tighten optionId/freeText — null option with null freeText is accepted', () => {
    // The cloud sends the unused side as an explicit null; the receiver must not
    // re-impose an XOR refine.
    expect(
      GateAnswerSchema.safeParse({ ...canonicalAnswer, optionId: null, freeText: null }).success,
    ).toBe(true);
  });

  it('allows a null actor email and displayName', () => {
    expect(
      GateAnswerSchema.safeParse({
        ...canonicalAnswer,
        actor: { userId: 'u', email: null, displayName: null },
      }).success,
    ).toBe(true);
  });

  it('rejects a malformed (non-null) actor email', () => {
    expect(
      GateAnswerSchema.safeParse({
        ...canonicalAnswer,
        actor: { ...canonicalAnswer.actor, email: 'not-an-email' },
      }).success,
    ).toBe(false);
  });

  it('rejects the wrong type discriminator', () => {
    expect(GateAnswerSchema.safeParse({ ...canonicalAnswer, type: 'gate-open' }).success).toBe(
      false,
    );
  });

  it('requires deliveryId', () => {
    const { deliveryId: _d, ...withoutDelivery } = canonicalAnswer;
    void _d;
    expect(GateAnswerSchema.safeParse(withoutDelivery).success).toBe(false);
  });
});

describe('gateKey / gateId derivation', () => {
  it('emits `<issueRef>:<gateType>:<generation>` verbatim (issueRef already owner/repo#N)', () => {
    expect(deriveGateKey('generacy-ai/generacy#1020', 'artifact-review', 'spec-review:abc1234')).toBe(
      'generacy-ai/generacy#1020:artifact-review:spec-review:abc1234',
    );
  });

  it('coerces a numeric generation to string', () => {
    expect(deriveGateKey('generacy-ai/generacy#1000', 'phase-queue', 2)).toBe(
      'generacy-ai/generacy#1000:phase-queue:2',
    );
  });

  it('deriveGateId is deterministic and 24 lowercase hex chars', () => {
    const key = 'generacy-ai/generacy#1020:artifact-review:spec-review:abc1234';
    expect(deriveGateId(key)).toBe(deriveGateId(key));
    expect(deriveGateId(key)).toMatch(/^[0-9a-f]{24}$/);
  });

  it('matches a hand-computed sha256 prefix for a fixed pre-image (algorithm lock)', () => {
    const key = 'generacy-ai/generacy#1020:artifact-review:spec-review:abc1234';
    expect(deriveGateId(key)).toBe('65d9cea2c9b50f53efde6ecb');
  });

  it('changes when gateType or generation changes', () => {
    const a = deriveGateId(deriveGateKey('r#1', 'artifact-review', 'x'));
    const b = deriveGateId(deriveGateKey('r#1', 'implementation-review', 'x'));
    const c = deriveGateId(deriveGateKey('r#1', 'artifact-review', 'y'));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
