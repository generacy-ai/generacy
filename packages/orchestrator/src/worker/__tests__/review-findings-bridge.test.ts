// #1156 T009 — pure bridge ReviewArtifact -> FindingsArtifact (FR-002/FR-003).
//
// SC-002: every input finding lands in the output (no finding dropped).
// Severity-threshold matrix: critical/major/minor x blockingSeverity in
//   {critical, major, minor} (per contracts/review-findings-bridge.md).
// anchor present iff `line` present; `status:'resolved'` -> `resolved:true`.
// marker stable across `line`/`detail` drift, distinct across `title`/`file`.
import { describe, it, expect } from 'vitest';
import { bridgeReviewArtifact, synthesizeMarker } from '../review-findings-bridge.js';
import type { ReviewArtifact, ReviewFinding, Severity } from '../review-artifact.js';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'critical',
    file: 'src/a.ts',
    title: 'Title',
    detail: 'Detail',
    round: 1,
    status: 'open',
    ...overrides,
  };
}

function artifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    findings: [finding()],
    verdict: 'changes-required',
    round: 1,
    lastReviewedCommitSha: 'a1b2c3d4',
    remediationCount: 0,
    markedReadyByEngine: false,
    ...overrides,
  };
}

describe('#1156 bridgeReviewArtifact', () => {
  it('SC-002: every input finding lands in the output (no finding dropped)', () => {
    const input = artifact({
      findings: [
        finding({ file: 'src/a.ts', title: 'A' }),
        finding({ file: 'src/b.ts', title: 'B' }),
        finding({ file: 'src/c.ts', title: 'C' }),
      ],
    });

    const result = bridgeReviewArtifact(input, 'critical');

    expect(result.findings).toHaveLength(3);
  });

  it('passes the verdict through unchanged', () => {
    expect(bridgeReviewArtifact(artifact({ verdict: 'clean' }), 'critical').verdict).toBe('clean');
    expect(
      bridgeReviewArtifact(artifact({ verdict: 'changes-required' }), 'critical').verdict,
    ).toBe('changes-required');
  });

  it('joins title + detail into the comment text', () => {
    const result = bridgeReviewArtifact(
      artifact({ findings: [finding({ title: 'My title', detail: 'My detail' })] }),
      'critical',
    );
    expect(result.findings[0]!.text).toBe('My title\n\nMy detail');
  });

  describe('severity-threshold matrix', () => {
    const cases: Array<{
      severity: Severity;
      blockingSeverity: Severity;
      expected: 'blocking' | 'advisory';
    }> = [
      { severity: 'critical', blockingSeverity: 'critical', expected: 'blocking' },
      { severity: 'critical', blockingSeverity: 'major', expected: 'blocking' },
      { severity: 'critical', blockingSeverity: 'minor', expected: 'blocking' },
      { severity: 'major', blockingSeverity: 'critical', expected: 'advisory' },
      { severity: 'major', blockingSeverity: 'major', expected: 'blocking' },
      { severity: 'major', blockingSeverity: 'minor', expected: 'blocking' },
      { severity: 'minor', blockingSeverity: 'critical', expected: 'advisory' },
      { severity: 'minor', blockingSeverity: 'major', expected: 'advisory' },
      { severity: 'minor', blockingSeverity: 'minor', expected: 'blocking' },
    ];

    it.each(cases)(
      'finding.severity=$severity blockingSeverity=$blockingSeverity -> $expected',
      ({ severity, blockingSeverity, expected }) => {
        const result = bridgeReviewArtifact(
          artifact({ findings: [finding({ severity })] }),
          blockingSeverity,
        );
        expect(result.findings[0]!.severity).toBe(expected);
      },
    );
  });

  it('carries an anchor only when line is present', () => {
    const withLine = bridgeReviewArtifact(
      artifact({ findings: [finding({ file: 'src/x.ts', line: 42 })] }),
      'critical',
    );
    expect(withLine.findings[0]!.anchor).toEqual({ file: 'src/x.ts', line: 42 });

    const withoutLine = bridgeReviewArtifact(
      artifact({ findings: [finding({ file: 'src/x.ts', line: undefined })] }),
      'critical',
    );
    expect(withoutLine.findings[0]!.anchor).toBeUndefined();
  });

  it('maps status:resolved -> resolved:true and status:open -> resolved:false', () => {
    const resolved = bridgeReviewArtifact(
      artifact({ findings: [finding({ status: 'resolved' })] }),
      'critical',
    );
    expect(resolved.findings[0]!.resolved).toBe(true);

    const open = bridgeReviewArtifact(
      artifact({ findings: [finding({ status: 'open' })] }),
      'critical',
    );
    expect(open.findings[0]!.resolved).toBe(false);
  });

  it('does not throw on an empty findings array', () => {
    const result = bridgeReviewArtifact(artifact({ findings: [] }), 'critical');
    expect(result.findings).toHaveLength(0);
  });
});

describe('#1156 synthesizeMarker', () => {
  it('is 24 hex chars', () => {
    const marker = synthesizeMarker('src/a.ts', 'Some title');
    expect(marker).toMatch(/^[0-9a-f]{24}$/);
  });

  it('is stable for identical (file, title) across calls', () => {
    expect(synthesizeMarker('src/a.ts', 'T')).toBe(synthesizeMarker('src/a.ts', 'T'));
  });

  it('is stable across line/detail drift (marker only depends on file+title)', () => {
    // The bridge synthesizes the marker from file+title only, so two findings
    // differing solely in line/detail produce the same marker (SC-004).
    const round1 = bridgeReviewArtifact(
      artifact({ findings: [finding({ file: 'src/a.ts', title: 'T', line: 10, detail: 'd1' })] }),
      'critical',
    );
    const round2 = bridgeReviewArtifact(
      artifact({ findings: [finding({ file: 'src/a.ts', title: 'T', line: 55, detail: 'd2' })] }),
      'critical',
    );
    expect(round1.findings[0]!.marker).toBe(round2.findings[0]!.marker);
  });

  it('is distinct for differing title', () => {
    expect(synthesizeMarker('src/a.ts', 'T1')).not.toBe(synthesizeMarker('src/a.ts', 'T2'));
  });

  it('is distinct for differing file', () => {
    expect(synthesizeMarker('src/a.ts', 'T')).not.toBe(synthesizeMarker('src/b.ts', 'T'));
  });

  it('is collision-safe at the file/title boundary', () => {
    expect(synthesizeMarker('ab', 'c')).not.toBe(synthesizeMarker('a', 'bc'));
  });
});
