import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../findings-artifact.js';
import {
  advanceArtifact,
  computeVerdict,
  filterNewFindings,
} from '../findings-advance.js';
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
    const { kept, dropped } = filterNewFindings(news, 1, 'critical');
    expect(kept).toHaveLength(2);
    expect(dropped).toEqual([]);
  });

  it('round >= 2 drops sub-blocking findings', () => {
    const news = [
      finding({ id: 'minor', severity: 'minor' }),
      finding({ id: 'major', severity: 'major' }),
      finding({ id: 'critical', severity: 'critical' }),
    ];
    const { kept, dropped } = filterNewFindings(news, 2, 'critical');
    expect(kept.map((f) => f.id)).toEqual(['critical']);
    expect(dropped.map((f) => f.id)).toEqual(['minor', 'major']);
  });

  it('round >= 2 with major threshold keeps major and above', () => {
    const news = [
      finding({ id: 'minor', severity: 'minor' }),
      finding({ id: 'major', severity: 'major' }),
    ];
    const { kept, dropped } = filterNewFindings(news, 2, 'major');
    expect(kept.map((f) => f.id)).toEqual(['major']);
    expect(dropped.map((f) => f.id)).toEqual(['minor']);
  });
});

describe('computeVerdict (FR-008)', () => {
  it('changes-required when an open finding is at/above blockingSeverity', () => {
    const artifact = {
      round: 2,
      findings: [finding({ severity: 'critical', status: 'open' })],
    };
    expect(computeVerdict(artifact, 'critical')).toBe('changes-required');
  });

  it('clean when only sub-blocking open findings remain', () => {
    const artifact = {
      round: 2,
      findings: [finding({ severity: 'minor', status: 'open' })],
    };
    expect(computeVerdict(artifact, 'critical')).toBe('clean');
  });

  it('clean when all blocking findings are resolved', () => {
    const artifact = {
      round: 2,
      findings: [finding({ severity: 'critical', status: 'resolved' })],
    };
    expect(computeVerdict(artifact, 'critical')).toBe('clean');
  });
});

describe('advanceArtifact (FR-006 / SC-002 / SC-004)', () => {
  it('resolves addressed delta-located open findings', () => {
    const artifact = { round: 1, findings: [finding({ id: 'f1', file: 'src/a.ts' })] };
    const result = advanceArtifact({
      artifact,
      delta: delta({ files: ['src/a.ts'] }),
      reviewerAddressed: ['f1'],
      reviewerNewFindings: [],
      blockingSeverity: 'critical',
    });
    expect(result.artifact.findings[0].status).toBe('resolved');
    expect(result.verdict).toBe('clean');
    expect(result.artifact.lastReviewedSha).toBe('HEAD');
    expect(result.artifact.round).toBe(2);
  });

  it('leaves addressed but non-delta open findings untouched (Q2)', () => {
    const artifact = { round: 1, findings: [finding({ id: 'f1', file: 'src/other.ts' })] };
    const result = advanceArtifact({
      artifact,
      delta: delta({ files: ['src/a.ts'] }),
      reviewerAddressed: ['f1'],
      reviewerNewFindings: [],
      blockingSeverity: 'critical',
    });
    expect(result.artifact.findings[0].status).toBe('open');
    expect(result.verdict).toBe('changes-required');
  });

  it('leaves unaddressed delta-located open findings untouched', () => {
    const artifact = { round: 1, findings: [finding({ id: 'f1', file: 'src/a.ts' })] };
    const result = advanceArtifact({
      artifact,
      delta: delta({ files: ['src/a.ts'] }),
      reviewerAddressed: [],
      reviewerNewFindings: [],
      blockingSeverity: 'critical',
    });
    expect(result.artifact.findings[0].status).toBe('open');
  });

  it('never re-opens a resolved finding (Q1)', () => {
    const artifact = {
      round: 1,
      findings: [finding({ id: 'f1', file: 'src/a.ts', status: 'resolved' })],
    };
    const result = advanceArtifact({
      artifact,
      delta: delta({ files: ['src/a.ts'] }),
      reviewerAddressed: [],
      reviewerNewFindings: [],
      blockingSeverity: 'critical',
    });
    expect(result.artifact.findings[0].status).toBe('resolved');
  });

  it('drops new advisory findings on round >= 2 and appends blocking with delta round', () => {
    const artifact = { round: 1, findings: [], lastReviewedSha: 'LAST' };
    const result = advanceArtifact({
      artifact,
      delta: delta({ round: 2 }),
      reviewerAddressed: [],
      reviewerNewFindings: [
        finding({ id: 'new-minor', severity: 'minor' }),
        finding({ id: 'new-critical', severity: 'critical' }),
      ],
      blockingSeverity: 'critical',
    });
    expect(result.artifact.findings.map((f) => f.id)).toEqual(['new-critical']);
    expect(result.artifact.findings[0].round).toBe(2);
    expect(result.droppedSubBlocking.map((f) => f.id)).toEqual(['new-minor']);
    expect(result.verdict).toBe('changes-required');
  });

  it('keeps new advisory findings on round 1', () => {
    const artifact = { round: 0, findings: [] };
    const result = advanceArtifact({
      artifact,
      delta: delta({ round: 1 }),
      reviewerAddressed: [],
      reviewerNewFindings: [finding({ id: 'new-minor', severity: 'minor' })],
      blockingSeverity: 'critical',
    });
    expect(result.artifact.findings.map((f) => f.id)).toEqual(['new-minor']);
    expect(result.droppedSubBlocking).toEqual([]);
  });

  it('does not mutate the input artifact (immutable transition)', () => {
    const original = finding({ id: 'f1', file: 'src/a.ts', status: 'open' });
    const artifact = { round: 1, findings: [original] };
    advanceArtifact({
      artifact,
      delta: delta({ files: ['src/a.ts'] }),
      reviewerAddressed: ['f1'],
      reviewerNewFindings: [],
      blockingSeverity: 'critical',
    });
    expect(original.status).toBe('open');
    expect(artifact.findings[0].status).toBe('open');
  });
});
