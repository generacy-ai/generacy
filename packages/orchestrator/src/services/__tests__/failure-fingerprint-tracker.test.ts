import { describe, it, expect, vi } from 'vitest';
import { GitHubCommentFailureFingerprintTracker } from '../failure-fingerprint-tracker.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { Logger } from '../../worker/types.js';
import { FAILURE_ALERT_MARKER_PREFIX } from '../../worker/types.js';

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

function stubGithub(getIssueComments: () => Promise<{ id: number; body: string }[]>): GitHubClient {
  return {
    getIssueComments: vi.fn(getIssueComments),
  } as unknown as GitHubClient;
}

// Utility: fabricate a v2 marker comment body.
function v2Comment(
  id: number,
  runId: string,
  fingerprint: string,
  occurrence: number,
  stage: 'implementation' | 'planning' | 'specification' = 'implementation',
): { id: number; body: string } {
  return {
    id,
    body:
      `${FAILURE_ALERT_MARKER_PREFIX}${stage}:${runId} --> <!-- fp:${fingerprint}:${occurrence} -->\n` +
      `❌ **implement failed** — body body body`,
  };
}

// Utility: fabricate a v1 (pre-#942) marker comment body.
function v1Comment(id: number, runId: string): { id: number; body: string } {
  return {
    id,
    body:
      `${FAILURE_ALERT_MARKER_PREFIX}implementation:${runId} -->\n` +
      `❌ **implement failed** — legacy body`,
  };
}

describe('GitHubCommentFailureFingerprintTracker', () => {
  it('INV-T1 — zero prior comments returns 0', async () => {
    const github = stubGithub(async () => []);
    const logger = makeLogger();
    const tracker = new GitHubCommentFailureFingerprintTracker(github, logger);
    const count = await tracker.countPriorOccurrences('owner', 'repo', 1, 'abcdef1234567890');
    expect(count).toBe(0);
  });

  it('INV-T2 — counts N prior matching-fingerprint comments (excludes in-flight)', async () => {
    // Two matching v2 comments already exist; the caller has NOT yet posted the
    // in-flight one — so we return 2 (the caller adds +1 to get occurrence=3).
    const fp = '9c4d3e2a1b0f8a7b';
    const github = stubGithub(async () => [
      v2Comment(1, 'runId-a', fp, 1),
      v2Comment(2, 'runId-b', fp, 2),
    ]);
    const tracker = new GitHubCommentFailureFingerprintTracker(github, makeLogger());
    const count = await tracker.countPriorOccurrences('owner', 'repo', 42, fp);
    expect(count).toBe(2);
  });

  it('INV-T3 — storage failure returns 0 and never throws', async () => {
    const github = stubGithub(async () => {
      throw new Error('GitHub API 503');
    });
    const logger = makeLogger();
    const tracker = new GitHubCommentFailureFingerprintTracker(github, logger);
    const count = await tracker.countPriorOccurrences('owner', 'repo', 1, 'abcdef1234567890');
    expect(count).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('GitHub API 503') }),
      expect.stringContaining('Failed to scan issue comments'),
    );
  });

  it('INV-T4 — non-marker comments are skipped (no throw, no false count)', async () => {
    const fp = '9c4d3e2a1b0f8a7b';
    const github = stubGithub(async () => [
      { id: 100, body: 'a plain user comment' },
      { id: 101, body: '<!-- generacy-stage:implementation -->\nsome stage comment' },
      v2Comment(102, 'runId-a', fp, 1),
    ]);
    const tracker = new GitHubCommentFailureFingerprintTracker(github, makeLogger());
    const count = await tracker.countPriorOccurrences('owner', 'repo', 1, fp);
    expect(count).toBe(1);
  });

  it('INV-T4 — v1-marker-only comments (pre-#942) are counted 0 (parseFailureAlertMarker → null)', async () => {
    const fp = '9c4d3e2a1b0f8a7b';
    const github = stubGithub(async () => [
      v1Comment(50, 'runId-x'),
      v1Comment(51, 'runId-y'),
      v2Comment(52, 'runId-z', fp, 1),
    ]);
    const tracker = new GitHubCommentFailureFingerprintTracker(github, makeLogger());
    const count = await tracker.countPriorOccurrences('owner', 'repo', 1, fp);
    expect(count).toBe(1);
  });

  it('INV-T5 — ordering-independent: matching fingerprints anywhere in the list', async () => {
    const fp = '9c4d3e2a1b0f8a7b';
    const otherFp = '1111111111111111';
    const github = stubGithub(async () => [
      v2Comment(1, 'runId-a', fp, 1),
      v2Comment(2, 'runId-b', otherFp, 1),
      v2Comment(3, 'runId-c', fp, 2),
      v2Comment(4, 'runId-d', otherFp, 2),
      v2Comment(5, 'runId-e', fp, 3),
    ]);
    const tracker = new GitHubCommentFailureFingerprintTracker(github, makeLogger());
    const count = await tracker.countPriorOccurrences('owner', 'repo', 1, fp);
    expect(count).toBe(3);
  });

  it('does NOT count comments with a different fingerprint', async () => {
    const targetFp = '9c4d3e2a1b0f8a7b';
    const otherFp = '1111111111111111';
    const github = stubGithub(async () => [
      v2Comment(1, 'runId-a', otherFp, 1),
      v2Comment(2, 'runId-b', otherFp, 2),
    ]);
    const tracker = new GitHubCommentFailureFingerprintTracker(github, makeLogger());
    const count = await tracker.countPriorOccurrences('owner', 'repo', 1, targetFp);
    expect(count).toBe(0);
  });
});
