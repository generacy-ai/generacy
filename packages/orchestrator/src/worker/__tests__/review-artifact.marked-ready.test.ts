// #1156 T011 — markedReadyByEngine sidecar persistence (FR-006/FR-007, D-6/D-7).
//
// Round-trip: setMarkedReadyByEngine writes the flag; readReviewArtifact reads it.
// Back-compat: a pre-#1156 artifact (no field) parses, defaulting to false.
// Carry-forward: an executor-style full rewrite that preserves the field keeps it.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeReviewArtifact,
  readReviewArtifact,
  setMarkedReadyByEngine,
  getReviewArtifactPath,
  type ReviewArtifact,
} from '../review-artifact.js';

const WORKFLOW_ID = 'test/repo#1156';

function baseArtifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    findings: [
      { severity: 'critical', file: 'src/a.ts', title: 't', detail: 'd', round: 1, status: 'open' },
    ],
    verdict: 'changes-required',
    round: 1,
    lastReviewedCommitSha: 'a1b2c3d4',
    remediationCount: 0,
    markedReadyByEngine: false,
    ...overrides,
  };
}

describe('#1156 — markedReadyByEngine sidecar', () => {
  let checkoutPath: string;

  beforeEach(async () => {
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'marked-ready-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  it('round-trips: set true then read back true', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, baseArtifact({ markedReadyByEngine: false }));

    await setMarkedReadyByEngine(checkoutPath, WORKFLOW_ID, true);

    const persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.markedReadyByEngine).toBe(true);
  });

  it('round-trips: set false then read back false', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, baseArtifact({ markedReadyByEngine: true }));

    await setMarkedReadyByEngine(checkoutPath, WORKFLOW_ID, false);

    const persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.markedReadyByEngine).toBe(false);
  });

  it('is a no-op when the artifact is missing', async () => {
    await setMarkedReadyByEngine(checkoutPath, WORKFLOW_ID, true);
    expect(await readReviewArtifact(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('leaves round + remediationCount + lastReviewedCommitSha untouched', async () => {
    await writeReviewArtifact(
      checkoutPath,
      WORKFLOW_ID,
      baseArtifact({ round: 3, remediationCount: 2, lastReviewedCommitSha: 'deadbeef' }),
    );

    await setMarkedReadyByEngine(checkoutPath, WORKFLOW_ID, true);

    const persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.round).toBe(3);
    expect(persisted!.remediationCount).toBe(2);
    expect(persisted!.lastReviewedCommitSha).toBe('deadbeef');
    expect(persisted!.markedReadyByEngine).toBe(true);
  });

  it('back-compat: a pre-#1156 artifact missing the field parses, defaulting to false', async () => {
    const legacy = {
      findings: [
        { severity: 'major', file: 'src/b.ts', title: 't', detail: 'd', round: 1, status: 'open' },
      ],
      verdict: 'changes-required',
      round: 2,
      lastReviewedCommitSha: 'legacy-sha',
      remediationCount: 1,
      // no markedReadyByEngine key
    };
    const filePath = getReviewArtifactPath(checkoutPath, WORKFLOW_ID);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(legacy, null, 2), 'utf-8');

    const parsed = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(parsed).not.toBeNull();
    expect(parsed!.markedReadyByEngine).toBe(false);
  });

  it('carry-forward: an executor-style full rewrite that preserves the field keeps it (D-7)', async () => {
    // Engine marked the PR ready in a prior round.
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, baseArtifact({ markedReadyByEngine: true }));
    const prior = await readReviewArtifact(checkoutPath, WORKFLOW_ID);

    // Review executor rewrites the whole artifact each round (explicit object,
    // review-executor.ts step 10) carrying markedReadyByEngine forward.
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings: [],
      verdict: 'clean',
      round: (prior!.round ?? 0) + 1,
      lastReviewedCommitSha: 'next-sha',
      remediationCount: prior!.remediationCount ?? 0,
      markedReadyByEngine: prior!.markedReadyByEngine ?? false,
    });

    const rewritten = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(rewritten!.markedReadyByEngine).toBe(true);
  });
});
