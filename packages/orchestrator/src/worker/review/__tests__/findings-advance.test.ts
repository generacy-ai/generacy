import { describe, expect, it } from 'vitest';
import type { ReviewArtifact, ReviewFinding } from '../../review-artifact.js';
import { computeVerdict } from '../../review-artifact.js';
import { advanceArtifact, filterNewFindings } from '../findings-advance.js';
import type { ReviewDelta } from '../review-delta.js';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'f1',
    severity: 'critical',
    file: 'src/a.ts',
    title: 'title',
    detail: 'detail',
    round: 1,
    status: 'open',
    ...overrides,
  };
}

function artifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    findings: [],
    verdict: 'changes-required',
    round: 1,
    lastReviewedCommitSha: 'LAST',
    remediationCount: 0,
    markedReadyByEngine: false,
    ...overrides,
  };
}

function delta(overrides: Partial<ReviewDelta> = {}): ReviewDelta {
  return {
    base: { source: 'last-reviewed', base: 'LAST', head: 'HEAD' },
    files: ['src/a.ts'],
    round: 2,
    ...overrides,
  };
}

describe('filterNewFindings (FR-005 / Q3 / SC-003)', () => {
  it('round 1 keeps all findings including advisory', () => {
    const news = [finding({ severity: 'minor' }), finding({ severity: 'critical' })];
    const kept = filterNewFindings(news, 1, 'critical');
    expect(kept).toHaveLength(2);
  });

  it('round >= 2 drops sub-blocking findings', () => {
    const news = [
      finding({ id: 'minor', severity: 'minor' }),
      finding({ id: 'major', severity: 'major' }),
      finding({ id: 'critical', severity: 'critical' }),
    ];
    const kept = filterNewFindings(news, 2, 'critical');
    expect(kept.map((f) => f.id)).toEqual(['critical']);
  });

  it('round >= 2 with major threshold keeps major and above', () => {
    const news = [
      finding({ id: 'minor', severity: 'minor' }),
      finding({ id: 'major', severity: 'major' }),
    ];
    const kept = filterNewFindings(news, 2, 'major');
    expect(kept.map((f) => f.id)).toEqual(['major']);
  });
});

describe('computeVerdict (FR-008)', () => {
  it('changes-required when an open finding is at/above blockingSeverity', () => {
    const findings = [finding({ severity: 'critical', status: 'open' })];
    expect(computeVerdict(findings, 'critical')).toBe('changes-required');
  });

  it('clean when only sub-blocking open findings remain', () => {
    const findings = [finding({ severity: 'minor', status: 'open' })];
    expect(computeVerdict(findings, 'critical')).toBe('clean');
  });

  it('clean when all blocking findings are resolved', () => {
    const findings = [finding({ severity: 'critical', status: 'resolved' })];
    expect(computeVerdict(findings, 'critical')).toBe('clean');
  });
});

describe('advanceArtifact (FR-006 / SC-002 / SC-004)', () => {
  it('resolves addressed delta-located open findings', () => {
    const prior = artifact({ round: 1, findings: [finding({ id: 'f1', file: 'src/a.ts' })] });
    const merged = advanceArtifact(
      prior,
      delta({ files: ['src/a.ts'] }),
      [finding({ id: 'f1', file: 'src/a.ts' })],
      [],
      'critical',
    );
    expect(merged[0]?.status).toBe('resolved');
    expect(computeVerdict(merged, 'critical')).toBe('clean');
  });

  it('leaves addressed but non-delta open findings untouched (Q2)', () => {
    const prior = artifact({ round: 1, findings: [finding({ id: 'f1', file: 'src/other.ts' })] });
    const merged = advanceArtifact(
      prior,
      delta({ files: ['src/a.ts'] }),
      [finding({ id: 'f1', file: 'src/other.ts' })],
      [],
      'critical',
    );
    expect(merged[0]?.status).toBe('open');
    expect(computeVerdict(merged, 'critical')).toBe('changes-required');
  });

  it('leaves unaddressed delta-located open findings untouched', () => {
    const prior = artifact({ round: 1, findings: [finding({ id: 'f1', file: 'src/a.ts' })] });
    const merged = advanceArtifact(prior, delta({ files: ['src/a.ts'] }), [], [], 'critical');
    expect(merged[0]?.status).toBe('open');
  });

  it('never re-opens a resolved finding (Q1)', () => {
    const prior = artifact({
      round: 1,
      findings: [finding({ id: 'f1', file: 'src/a.ts', status: 'resolved' })],
    });
    const merged = advanceArtifact(prior, delta({ files: ['src/a.ts'] }), [], [], 'critical');
    expect(merged[0]?.status).toBe('resolved');
  });

  it('drops new advisory findings on round >= 2 and appends blocking with delta round', () => {
    const prior = artifact({ round: 1, findings: [] });
    const merged = advanceArtifact(
      prior,
      delta({ round: 2 }),
      [],
      [
        finding({ id: 'new-minor', severity: 'minor' }),
        finding({ id: 'new-critical', severity: 'critical' }),
      ],
      'critical',
    );
    expect(merged.map((f) => f.id)).toEqual(['new-critical']);
    expect(merged[0]?.round).toBe(2);
    expect(computeVerdict(merged, 'critical')).toBe('changes-required');
  });

  it('keeps new advisory findings on round 1', () => {
    const prior = artifact({ round: 1, findings: [] });
    const merged = advanceArtifact(
      prior,
      delta({ round: 1 }),
      [],
      [finding({ id: 'new-minor', severity: 'minor' })],
      'critical',
    );
    expect(merged.map((f) => f.id)).toEqual(['new-minor']);
  });

  it('carries a round-1 open finding forward when the round-2 candidate omits it (SC-005)', () => {
    const prior = artifact({
      round: 1,
      findings: [finding({ id: 'carry', file: 'src/a.ts', status: 'open' })],
    });
    // round-2 candidate addresses nothing and reports no new findings.
    const merged = advanceArtifact(prior, delta({ files: ['src/b.ts'] }), [], [], 'critical');
    expect(merged.map((f) => f.id)).toEqual(['carry']);
    expect(merged[0]?.status).toBe('open');
    expect(computeVerdict(merged, 'critical')).toBe('changes-required');
  });

  it('does not mutate the input artifact (immutable transition)', () => {
    const original = finding({ id: 'f1', file: 'src/a.ts', status: 'open' });
    const prior = artifact({ round: 1, findings: [original] });
    advanceArtifact(
      prior,
      delta({ files: ['src/a.ts'] }),
      [finding({ id: 'f1', file: 'src/a.ts' })],
      [],
      'critical',
    );
    expect(original.status).toBe('open');
    expect(prior.findings[0]?.status).toBe('open');
  });

  it('treats a null prior as an empty findings set', () => {
    const merged = advanceArtifact(
      null,
      delta({ round: 2 }),
      [],
      [finding({ id: 'fresh', severity: 'critical' })],
      'critical',
    );
    expect(merged.map((f) => f.id)).toEqual(['fresh']);
  });

  it('de-dupes a re-emitted unaddressed finding against its carried-forward prior (id-uniqueness)', () => {
    // Round 1 persisted an open critical finding X; round 2 does not address it,
    // so the agent re-emits the identical file+title (same deterministic id X) as
    // an "open" new finding. The prior is carried forward AND the re-emission
    // survives filterNewFindings — appending both would duplicate id X.
    const prior = artifact({
      round: 1,
      findings: [finding({ id: 'X', file: 'src/a.ts', status: 'open', round: 1 })],
    });
    const merged = advanceArtifact(
      prior,
      delta({ round: 2, files: ['src/b.ts'] }),
      [],
      [finding({ id: 'X', file: 'src/a.ts', status: 'open', severity: 'critical' })],
      'critical',
    );
    expect(merged.filter((f) => f.id === 'X')).toHaveLength(1);
    // The carried-forward instance wins — its original round is preserved.
    expect(merged[0]?.round).toBe(1);
    expect(merged[0]?.status).toBe('open');
  });

  it('de-dupes duplicate ids within a single round of new findings', () => {
    const merged = advanceArtifact(
      null,
      delta({ round: 2 }),
      [],
      [
        finding({ id: 'dup', file: 'src/a.ts', severity: 'critical' }),
        finding({ id: 'dup', file: 'src/a.ts', severity: 'critical' }),
      ],
      'critical',
    );
    expect(merged.filter((f) => f.id === 'dup')).toHaveLength(1);
  });
});
