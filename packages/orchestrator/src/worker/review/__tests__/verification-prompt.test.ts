import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../findings-artifact.js';
import { buildVerificationPrompt } from '../verification-prompt.js';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'f1',
    severity: 'critical',
    file: 'src/a.ts',
    line: 42,
    title: 'Null deref in handler',
    detail: 'The handler dereferences `req.user` before the auth guard runs.',
    round: 1,
    status: 'open',
    ...overrides,
  };
}

describe('buildVerificationPrompt (FR-004 / SC-006)', () => {
  it('contains the literal round number', () => {
    const out = buildVerificationPrompt({ round: 2, openFindings: [], charter: 'verification' });
    expect(out).toContain('Round 2');
  });

  it('includes verification-charter framing when charter is verification', () => {
    const out = buildVerificationPrompt({ round: 2, openFindings: [], charter: 'verification' });
    expect(out.toLowerCase()).toContain('verification');
  });

  it('uses standard framing when charter is standard', () => {
    const out = buildVerificationPrompt({ round: 1, openFindings: [], charter: 'standard' });
    expect(out).toContain('Standard review pass.');
  });

  it('enumerates each open finding title and detail verbatim', () => {
    const f = finding();
    const out = buildVerificationPrompt({
      round: 2,
      openFindings: [f],
      charter: 'verification',
    });
    expect(out).toContain(f.title);
    expect(out).toContain(f.detail);
    expect(out).toContain('src/a.ts:42');
  });

  it('renders location without line when line is absent', () => {
    const f = finding({ line: undefined });
    const out = buildVerificationPrompt({
      round: 2,
      openFindings: [f],
      charter: 'verification',
    });
    expect(out).toContain('(src/a.ts)');
  });

  it('states none when there are no open findings', () => {
    const out = buildVerificationPrompt({ round: 2, openFindings: [], charter: 'verification' });
    expect(out).toContain('Open findings: none.');
  });
});

describe('buildVerificationPrompt — synthetic findings', () => {
  it('tags a synthetic finding and explains how to confirm it', () => {
    const out = buildVerificationPrompt({
      round: 3,
      openFindings: [
        finding({
          id: 'v1',
          file: 'pnpm test && pnpm build',
          line: undefined,
          title: 'validate phase failed',
          synthetic: 'validate',
        }),
      ],
      charter: 'verification',
    });
    expect(out).toContain('validate phase failed (pnpm test && pnpm build) [synthetic: validate]');
    expect(out).toContain('`[synthetic: validate]`');
    expect(out).toContain('`status: "resolved"`');
  });

  it('does not emit the synthetic explainer when no finding is synthetic', () => {
    const out = buildVerificationPrompt({ round: 2, openFindings: [finding()], charter: 'verification' });
    expect(out).not.toContain('[synthetic:');
  });
});
