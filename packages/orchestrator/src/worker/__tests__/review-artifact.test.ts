import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearReviewCandidate,
  computeVerdict,
  getReviewArtifactPath,
  getReviewArtifactRelPath,
  getReviewCandidatePath,
  getReviewCandidateRelPath,
  readCandidateFindings,
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

describe('review candidate sidecar (#1155, SC-002)', () => {
  let checkoutPath: string;

  beforeEach(async () => {
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'review-candidate-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
  });

  it('candidate path is sanitized and distinct from the engine artifact path', () => {
    const candidateAbs = getReviewCandidatePath(checkoutPath, WORKFLOW_ID);
    const candidateRel = getReviewCandidateRelPath(WORKFLOW_ID);
    expect(path.resolve(checkoutPath, candidateRel)).toBe(candidateAbs);
    expect(path.basename(candidateAbs)).toBe('review-candidate-acme_widgets_42.json');
    // Structurally distinct from the engine-authoritative artifact.
    expect(candidateAbs).not.toBe(getReviewArtifactPath(checkoutPath, WORKFLOW_ID));
  });

  it('clearReviewCandidate is idempotent — no throw on a missing file', async () => {
    await expect(clearReviewCandidate(checkoutPath, WORKFLOW_ID)).resolves.toBeUndefined();

    const filePath = getReviewCandidatePath(checkoutPath, WORKFLOW_ID);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ findings: [] }), 'utf-8');

    await clearReviewCandidate(checkoutPath, WORKFLOW_ID);
    await expect(fs.access(filePath)).rejects.toThrow();
    // Second clear on the now-missing file is still a no-op.
    await expect(clearReviewCandidate(checkoutPath, WORKFLOW_ID)).resolves.toBeUndefined();
  });

  async function writeCandidate(raw: unknown): Promise<void> {
    const filePath = getReviewCandidatePath(checkoutPath, WORKFLOW_ID);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(raw), 'utf-8');
  }

  it('returns null for a missing candidate (no proof of review)', async () => {
    expect(await readCandidateFindings(checkoutPath, WORKFLOW_ID, 1)).toBeNull();
  });

  it('returns null for invalid JSON (no proof of review)', async () => {
    const filePath = getReviewCandidatePath(checkoutPath, WORKFLOW_ID);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{ not json', 'utf-8');
    expect(await readCandidateFindings(checkoutPath, WORKFLOW_ID, 1)).toBeNull();
  });

  it('returns null for a schema-invalid candidate (no proof of review)', async () => {
    await writeCandidate({ findings: [{ severity: 'nope', file: '', title: '', detail: '' }] });
    expect(await readCandidateFindings(checkoutPath, WORKFLOW_ID, 1)).toBeNull();
  });

  it('does NOT read the engine artifact path — an engine artifact alone yields null', async () => {
    // Prior-round engine artifact present, but no candidate written this round.
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings: [finding()],
      verdict: 'changes-required',
      round: 1,
      lastReviewedCommitSha: 'abc',
      remediationCount: 0,
    });
    expect(await readCandidateFindings(checkoutPath, WORKFLOW_ID, 2)).toBeNull();
  });

  it('returns [] for a valid candidate with zero findings (genuine clean)', async () => {
    await writeCandidate({ findings: [] });
    expect(await readCandidateFindings(checkoutPath, WORKFLOW_ID, 1)).toEqual([]);
  });

  it('returns stamped findings for a populated candidate (round + status defaulted)', async () => {
    await writeCandidate({
      verdict: 'clean', // agent-claimed top-level — ignored
      findings: [{ severity: 'major', file: 'src/x.ts', title: 'T', detail: 'D' }],
    });
    const result = await readCandidateFindings(checkoutPath, WORKFLOW_ID, 3);
    expect(result).toEqual([
      { severity: 'major', file: 'src/x.ts', title: 'T', detail: 'D', round: 3, status: 'open' },
    ]);
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
