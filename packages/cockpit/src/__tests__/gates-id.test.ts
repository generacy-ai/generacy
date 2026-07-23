import { describe, expect, it } from 'vitest';
import { deriveGateId, deriveGateKey } from '../gates/index.js';

describe('deriveGateKey', () => {
  it('emits `<issueRef>:<gateType>:<generation>` verbatim (issueRef already owner/repo#N)', () => {
    const key = deriveGateKey(
      'generacy-ai/generacy#1020',
      'artifact-review',
      'spec-review:abc1234',
    );
    expect(key).toBe('generacy-ai/generacy#1020:artifact-review:spec-review:abc1234');
    expect(key).toMatch(/^[a-zA-Z0-9-_.]+\/[a-zA-Z0-9-_.]+#\d+:[a-z-]+:.+$/);
  });

  it('coerces a numeric generation to string', () => {
    expect(deriveGateKey('generacy-ai/generacy#1000', 'phase-queue', 2)).toBe(
      'generacy-ai/generacy#1000:phase-queue:2',
    );
  });
});

describe('deriveGateId', () => {
  it('is deterministic across invocations (a)', () => {
    const key = 'generacy-ai/generacy#1020:artifact-review:spec-review:abc1234';
    const a = deriveGateId(key);
    const b = deriveGateId(key);
    expect(a).toBe(b);
  });

  it('returns exactly 24 lowercase hex chars (b)', () => {
    const id = deriveGateId('any string at all');
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(id.length).toBe(24);
  });

  it('matches a hand-computed sha256 prefix for a fixed pre-image (c — algorithm lock)', () => {
    const key = 'generacy-ai/generacy#1020:artifact-review:spec-review:abc1234';
    // First 24 hex chars of sha256(key) — computed via node:crypto once and pinned.
    expect(deriveGateId(key)).toBe('65d9cea2c9b50f53efde6ecb');
  });

  it('changes when gateType changes (d)', () => {
    const issueRef = 'generacy-ai/generacy#1020';
    const a = deriveGateId(deriveGateKey(issueRef, 'artifact-review', 'x'));
    const b = deriveGateId(deriveGateKey(issueRef, 'implementation-review', 'x'));
    expect(a).not.toBe(b);
  });

  it('changes when generation changes (d)', () => {
    const issueRef = 'generacy-ai/generacy#1020';
    const a = deriveGateId(deriveGateKey(issueRef, 'artifact-review', 'g1'));
    const b = deriveGateId(deriveGateKey(issueRef, 'artifact-review', 'g2'));
    expect(a).not.toBe(b);
  });
});
