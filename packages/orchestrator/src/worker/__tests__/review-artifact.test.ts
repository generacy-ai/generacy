import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeVerdict,
  getReviewArtifactPath,
  getReviewArtifactRelPath,
  readReviewArtifact,
  readReviewArtifactSync,
  writeReviewArtifact,
  type ReviewArtifact,
  type ReviewFinding,
  type Severity,
} from '../review-artifact.js';

const WORKFLOW_ID = 'acme/widgets#42';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'critical',
    file: 'src/index.ts',
    title: 'Null deref',
    detail: 'Dereferences a possibly-null value',
    round: 1,
    status: 'open',
    ...overrides,
  };
}

describe('review-artifact I/O (SC-001)', () => {
  let checkoutPath: string;

  beforeEach(async () => {
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'review-artifact-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
  });

  it('round-trips a valid artifact through write → read (async and sync)', async () => {
    const artifact: ReviewArtifact = {
      findings: [finding({ line: 12 }), finding({ severity: 'minor', status: 'resolved' })],
      verdict: 'changes-required',
      round: 2,
      lastReviewedCommitSha: 'abc123def456',
      remediationCount: 0,
      markedReadyByEngine: false,
    };

    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, artifact);

    expect(await readReviewArtifact(checkoutPath, WORKFLOW_ID)).toEqual(artifact);
    expect(readReviewArtifactSync(checkoutPath, WORKFLOW_ID)).toEqual(artifact);
  });

  it('returns null for a missing file (async and sync)', async () => {
    expect(await readReviewArtifact(checkoutPath, WORKFLOW_ID)).toBeNull();
    expect(readReviewArtifactSync(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('returns null for malformed JSON (async and sync)', async () => {
    const filePath = getReviewArtifactPath(checkoutPath, WORKFLOW_ID);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{ not valid json', 'utf-8');

    expect(await readReviewArtifact(checkoutPath, WORKFLOW_ID)).toBeNull();
    expect(readReviewArtifactSync(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('returns null for schema-invalid content (async and sync)', async () => {
    const filePath = getReviewArtifactPath(checkoutPath, WORKFLOW_ID);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Valid JSON, but `verdict` is not a member of the enum and `round` is 0.
    await fs.writeFile(
      filePath,
      JSON.stringify({ findings: [], verdict: 'maybe', round: 0, lastReviewedCommitSha: 'x' }),
      'utf-8',
    );

    expect(await readReviewArtifact(checkoutPath, WORKFLOW_ID)).toBeNull();
    expect(readReviewArtifactSync(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('rel path resolved against checkoutPath equals the absolute path (agent + engine target same file)', () => {
    const abs = getReviewArtifactPath(checkoutPath, WORKFLOW_ID);
    const rel = getReviewArtifactRelPath(WORKFLOW_ID);
    expect(path.resolve(checkoutPath, rel)).toBe(abs);
  });

  it('sanitizes the workflow id into the filename', () => {
    const abs = getReviewArtifactPath(checkoutPath, 'acme/widgets#42');
    expect(path.basename(abs)).toBe('review-findings-acme_widgets_42.json');
  });
});

describe('computeVerdict severity/verdict matrix (SC-002)', () => {
  const cases: Array<{
    name: string;
    findings: ReviewFinding[];
    blockingSeverity: Severity;
    expected: 'clean' | 'changes-required';
  }> = [
    { name: 'empty → clean', findings: [], blockingSeverity: 'critical', expected: 'clean' },
    {
      name: 'minor vs critical → clean',
      findings: [finding({ severity: 'minor' })],
      blockingSeverity: 'critical',
      expected: 'clean',
    },
    {
      name: 'major vs critical → clean',
      findings: [finding({ severity: 'major' })],
      blockingSeverity: 'critical',
      expected: 'clean',
    },
    {
      name: 'critical vs critical → changes-required',
      findings: [finding({ severity: 'critical' })],
      blockingSeverity: 'critical',
      expected: 'changes-required',
    },
    {
      name: 'minor vs major → clean',
      findings: [finding({ severity: 'minor' })],
      blockingSeverity: 'major',
      expected: 'clean',
    },
    {
      name: 'major vs major → changes-required',
      findings: [finding({ severity: 'major' })],
      blockingSeverity: 'major',
      expected: 'changes-required',
    },
    {
      name: 'critical vs major → changes-required',
      findings: [finding({ severity: 'critical' })],
      blockingSeverity: 'major',
      expected: 'changes-required',
    },
    {
      name: 'minor vs minor → changes-required',
      findings: [finding({ severity: 'minor' })],
      blockingSeverity: 'minor',
      expected: 'changes-required',
    },
    {
      name: 'resolved critical excluded → clean',
      findings: [finding({ severity: 'critical', status: 'resolved' })],
      blockingSeverity: 'critical',
      expected: 'clean',
    },
    {
      name: 'resolved critical + open minor vs major → clean',
      findings: [
        finding({ severity: 'critical', status: 'resolved' }),
        finding({ severity: 'minor', status: 'open' }),
      ],
      blockingSeverity: 'major',
      expected: 'clean',
    },
  ];

  for (const { name, findings, blockingSeverity, expected } of cases) {
    it(name, () => {
      expect(computeVerdict(findings, blockingSeverity)).toBe(expected);
    });
  }
});
