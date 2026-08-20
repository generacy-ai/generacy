// #1128 — remediationCount helpers: bump / reset / back-compat parse.
//
// SC-001: `bumpRemediationCount` increments by exactly one per call.
// SC-003: `resetRemediationCount` returns the counter to 0 (fresh budget).
// INV-3:  neither helper touches `round` or `lastReviewedCommitSha`.
// Back-compat: a #1124 artifact written before this deploy (no
// `remediationCount` field) still parses, defaulting the counter to 0.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeReviewArtifact,
  readReviewArtifact,
  bumpRemediationCount,
  resetRemediationCount,
  getReviewArtifactPath,
  type ReviewArtifact,
} from '../review-artifact.js';

const WORKFLOW_ID = 'test/repo#1128';

function baseArtifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    findings: [
      { severity: 'critical', file: 'src/a.ts', title: 't', detail: 'd', round: 1, status: 'open' },
    ],
    verdict: 'changes-required',
    round: 1,
    lastReviewedCommitSha: 'a1b2c3d4',
    remediationCount: 0,
    ...overrides,
  };
}

describe('#1128 — remediationCount helpers', () => {
  let checkoutPath: string;

  beforeEach(async () => {
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'remediation-count-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  it('SC-001: bump increments remediationCount by exactly one and returns the new count', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, baseArtifact({ remediationCount: 0 }));

    expect(await bumpRemediationCount(checkoutPath, WORKFLOW_ID)).toBe(1);
    expect(await bumpRemediationCount(checkoutPath, WORKFLOW_ID)).toBe(2);
    expect(await bumpRemediationCount(checkoutPath, WORKFLOW_ID)).toBe(3);

    const persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.remediationCount).toBe(3);
  });

  it('SC-001: bump is a no-op returning 0 when the artifact is missing', async () => {
    expect(await bumpRemediationCount(checkoutPath, WORKFLOW_ID)).toBe(0);
    expect(await readReviewArtifact(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('SC-003: reset returns remediationCount to 0', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, baseArtifact({ remediationCount: 5 }));

    await resetRemediationCount(checkoutPath, WORKFLOW_ID);

    const persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.remediationCount).toBe(0);
  });

  it('SC-003: reset is a no-op when the artifact is missing', async () => {
    await resetRemediationCount(checkoutPath, WORKFLOW_ID);
    expect(await readReviewArtifact(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('INV-3: bump and reset leave round + lastReviewedCommitSha untouched', async () => {
    await writeReviewArtifact(
      checkoutPath,
      WORKFLOW_ID,
      baseArtifact({ round: 4, lastReviewedCommitSha: 'deadbeef', remediationCount: 1 }),
    );

    await bumpRemediationCount(checkoutPath, WORKFLOW_ID);
    let persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.round).toBe(4);
    expect(persisted!.lastReviewedCommitSha).toBe('deadbeef');
    expect(persisted!.remediationCount).toBe(2);

    await resetRemediationCount(checkoutPath, WORKFLOW_ID);
    persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.round).toBe(4);
    expect(persisted!.lastReviewedCommitSha).toBe('deadbeef');
    expect(persisted!.remediationCount).toBe(0);
  });

  it('back-compat: a #1124 artifact missing remediationCount still parses, defaulting to 0', async () => {
    // Simulate a sidecar written before #1128 — no `remediationCount` key.
    const legacy = {
      findings: [
        { severity: 'major', file: 'src/b.ts', title: 't', detail: 'd', round: 1, status: 'open' },
      ],
      verdict: 'changes-required',
      round: 2,
      lastReviewedCommitSha: 'legacy-sha',
    };
    const filePath = getReviewArtifactPath(checkoutPath, WORKFLOW_ID);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(legacy, null, 2), 'utf-8');

    const parsed = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(parsed).not.toBeNull();
    expect(parsed!.remediationCount).toBe(0);

    // And the counter can then be bumped from that default.
    expect(await bumpRemediationCount(checkoutPath, WORKFLOW_ID)).toBe(1);
  });
});
