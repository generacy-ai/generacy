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

  // #1053: `runId` is an optional per-run discriminator folded into the pre-image.
  it('back-compat: 3-arg call still hashes to the pre-#1053 field-instance vector', () => {
    // Regression guard against reverting the fix. Matches spec §Field instance:
    //   sha256("christrudelpw/snappoll#1:phase-queue:P2")[:24] = 075855bf0c3fef1b7f52ed3a
    expect(deriveGateKey('christrudelpw/snappoll#1', 'phase-queue', 'P2')).toBe(
      'christrudelpw/snappoll#1:phase-queue:P2',
    );
    expect(deriveGateId(deriveGateKey('christrudelpw/snappoll#1', 'phase-queue', 'P2'))).toBe(
      '075855bf0c3fef1b7f52ed3a',
    );
  });

  it('appends `:${runId}` when the optional 4th arg is a non-empty string', () => {
    const runId = 'christrudelpw-snappoll-1-20260727-200458';
    expect(deriveGateKey('christrudelpw/snappoll#1', 'phase-queue', 'P2', runId)).toBe(
      `christrudelpw/snappoll#1:phase-queue:P2:${runId}`,
    );
  });

  it('back-compat: passing runId undefined matches the 3-arg output byte-for-byte', () => {
    expect(deriveGateKey('christrudelpw/snappoll#1', 'phase-queue', 'P2', undefined)).toBe(
      deriveGateKey('christrudelpw/snappoll#1', 'phase-queue', 'P2'),
    );
  });
});

describe('deriveGateId with runId (#1053)', () => {
  const ref = 'christrudelpw/snappoll#1';
  const gen = 'P2';

  it('produces distinct gateIds for different runIds on the same natural gate', () => {
    const idA = deriveGateId(deriveGateKey(ref, 'phase-queue', gen, 'RA'));
    const idB = deriveGateId(deriveGateKey(ref, 'phase-queue', gen, 'RB'));
    expect(idA).not.toBe(idB);
  });

  it('runId-suffixed output shape is stable (24 lowercase hex chars)', () => {
    const id = deriveGateId(deriveGateKey(ref, 'phase-queue', gen, 'RA'));
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('runId-suffixed gateId differs from the no-runId gateId for the same triple', () => {
    const legacy = deriveGateId(deriveGateKey(ref, 'phase-queue', gen));
    const suffixed = deriveGateId(deriveGateKey(ref, 'phase-queue', gen, 'RA'));
    expect(suffixed).not.toBe(legacy);
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
