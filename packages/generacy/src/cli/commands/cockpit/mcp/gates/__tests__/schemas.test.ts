/**
 * #1077 — optional frameId wire-schema regression.
 *
 * Pins that both `GateOpenWireSchema` and `GateOutcomeWireSchema` accept the
 * optional `frameId` field so callers that hand-supply one pass the tool's
 * outbound self-check. Empty strings are rejected (min(1)), null is rejected,
 * and omitted/undefined is accepted.
 */
import { describe, it, expect } from 'vitest';
import { GateOpenWireSchema, GateOutcomeWireSchema } from '../schemas.js';

const GATE_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';

const validOpen = {
  type: 'gate-open' as const,
  gateId: GATE_ID,
  gateKey: 'generacy-ai/generacy#1077:clarification:1',
  gateType: 'clarification' as const,
  epicRef: 'generacy-ai/generacy#1000',
  issueRef: 'generacy-ai/generacy#1077',
  issueTitle: 'test',
  issueUrl: 'https://github.com/generacy-ai/generacy/issues/1077',
  title: 'test',
  body: 'test',
  options: [],
  allowFreeText: true,
  sessionId: 'sess-1',
  askedAt: '2026-07-29T00:00:00.000Z',
};

const validOutcome = {
  type: 'gate-outcome' as const,
  gateId: GATE_ID,
  outcome: 'applied' as const,
  at: '2026-07-29T00:00:00.000Z',
};

describe('GateOpenWireSchema — #1077 frameId field', () => {
  it('accepts a non-empty frameId', () => {
    const parsed = GateOpenWireSchema.safeParse({ ...validOpen, frameId: 'frm_abc' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.frameId).toBe('frm_abc');
    }
  });

  it('accepts an omitted frameId (optional)', () => {
    const parsed = GateOpenWireSchema.safeParse(validOpen);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.frameId).toBeUndefined();
    }
  });

  it('accepts an explicit undefined frameId (optional)', () => {
    const parsed = GateOpenWireSchema.safeParse({ ...validOpen, frameId: undefined });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty-string frameId (min(1))', () => {
    const parsed = GateOpenWireSchema.safeParse({ ...validOpen, frameId: '' });
    expect(parsed.success).toBe(false);
  });
});

describe('GateOutcomeWireSchema — #1077 frameId field', () => {
  it('accepts a non-empty frameId', () => {
    const parsed = GateOutcomeWireSchema.safeParse({ ...validOutcome, frameId: 'frm_xyz' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.frameId).toBe('frm_xyz');
    }
  });

  it('accepts an omitted frameId (optional)', () => {
    const parsed = GateOutcomeWireSchema.safeParse(validOutcome);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.frameId).toBeUndefined();
    }
  });

  it('accepts an explicit undefined frameId (optional)', () => {
    const parsed = GateOutcomeWireSchema.safeParse({ ...validOutcome, frameId: undefined });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty-string frameId (min(1))', () => {
    const parsed = GateOutcomeWireSchema.safeParse({ ...validOutcome, frameId: '' });
    expect(parsed.success).toBe(false);
  });
});
