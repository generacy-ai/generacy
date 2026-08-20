// #1130 (T013) — SeedAwareReviewExecutor.
//
// The seed-aware wrapper occupies the `deps.reviewExecutor` slot on the
// address-pr-feedback route. On the FIRST `review` round it consumes the
// external-feedback seed sidecar, synthesizes a findings artifact with
// `verdict === 'changes-required'` WITHOUT spawning the review CLI, deletes the
// seed (consume-once), and returns a synthetic success. Once the seed is gone
// (convergence rounds) it delegates to the real executor.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { Logger, PhaseResult, WorkerContext } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { ReviewExecutor } from '../review-executor.js';
import { SeedAwareReviewExecutor } from '../seed-aware-review-executor.js';
import {
  readExternalFeedbackSeed,
  writeExternalFeedbackSeed,
} from '../external-feedback-seed.js';
import { readReviewArtifact, writeReviewArtifact } from '../review-artifact.js';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Logger;

const WORKFLOW_ID = 'owner/repo#42';

function createItem(): QueueItem {
  return {
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'address-pr-feedback',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
  };
}

describe('SeedAwareReviewExecutor (#1130)', () => {
  let checkoutPath: string;

  function makeContext(github: GitHubClient): WorkerContext {
    return {
      workerId: 'w1',
      jobId: 'j1',
      item: createItem(),
      startPhase: 'review',
      github,
      logger,
      signal: new AbortController().signal,
      checkoutPath,
      issueUrl: 'https://github.com/owner/repo/issues/42',
      description: 'test',
    } as WorkerContext;
  }

  /** A delegate whose execute() must NOT run on the seed-present path. */
  function makeDelegate(result?: PhaseResult): {
    delegate: ReviewExecutor;
    execute: ReturnType<typeof vi.fn>;
  } {
    const execute = vi.fn(async (): Promise<PhaseResult> =>
      result ?? { phase: 'review', success: true, exitCode: 0, durationMs: 1, output: [] },
    );
    return { delegate: { execute } as unknown as ReviewExecutor, execute };
  }

  beforeEach(async () => {
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-review-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('seed present → writes changes-required artifact, deletes seed, no CLI spawn, no delegate', async () => {
    await writeExternalFeedbackSeed(checkoutPath, WORKFLOW_ID, {
      version: 1,
      prNumber: 99,
      seededAt: '2026-08-20T00:00:00.000Z',
      findings: [
        { id: 'c1', body: 'Fix null deref', author: 'octocat', path: 'src/a.ts', line: 12 },
        { id: 'r1', body: 'review body (no file anchor):\n\nDo X', author: 'octocat' },
      ],
    });

    const getCurrentCommitSha = vi.fn().mockResolvedValue('deadbeef');
    const github = { getCurrentCommitSha } as unknown as GitHubClient;
    const { delegate, execute } = makeDelegate();

    const executor = new SeedAwareReviewExecutor({ delegate, logger });
    const result = await executor.execute(makeContext(github));

    // Synthetic success without a CLI spawn (delegate never runs).
    expect(execute).not.toHaveBeenCalled();
    expect(result.phase).toBe('review');
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);

    // Artifact synthesized with a blocking verdict + one finding per seed finding.
    const artifact = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(artifact).not.toBeNull();
    expect(artifact?.verdict).toBe('changes-required');
    expect(artifact?.findings).toHaveLength(2);
    expect(artifact?.lastReviewedCommitSha).toBe('deadbeef');
    // Body-only finding falls back to the no-anchor file placeholder.
    const bodyFinding = artifact?.findings.find((f) => f.detail.startsWith('review body'));
    expect(bodyFinding?.file).toBe('(pr-review)');
    const inlineFinding = artifact?.findings.find((f) => f.file === 'src/a.ts');
    expect(inlineFinding?.line).toBe(12);

    // Consume-once: seed deleted so convergence rounds delegate.
    expect(await readExternalFeedbackSeed(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('seed absent → delegates to the real executor', async () => {
    const delegateResult: PhaseResult = {
      phase: 'review',
      success: true,
      exitCode: 0,
      durationMs: 7,
      output: [],
    };
    const github = { getCurrentCommitSha: vi.fn() } as unknown as GitHubClient;
    const { delegate, execute } = makeDelegate(delegateResult);

    const executor = new SeedAwareReviewExecutor({ delegate, logger });
    const result = await executor.execute(makeContext(github));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toBe(delegateResult);
  });

  it('round derives to 1 when no prior artifact exists', async () => {
    await writeExternalFeedbackSeed(checkoutPath, WORKFLOW_ID, {
      version: 1,
      prNumber: 99,
      seededAt: '2026-08-20T00:00:00.000Z',
      findings: [{ id: 'c1', body: 'Fix it', author: 'octocat' }],
    });
    const github = {
      getCurrentCommitSha: vi.fn().mockResolvedValue('cafe'),
    } as unknown as GitHubClient;
    const { delegate } = makeDelegate();

    await new SeedAwareReviewExecutor({ delegate, logger }).execute(makeContext(github));

    const artifact = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(artifact?.round).toBe(1);
  });

  it('round increments from a prior artifact', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings: [],
      verdict: 'clean',
      round: 3,
      lastReviewedCommitSha: 'prior',
    });
    await writeExternalFeedbackSeed(checkoutPath, WORKFLOW_ID, {
      version: 1,
      prNumber: 99,
      seededAt: '2026-08-20T00:00:00.000Z',
      findings: [{ id: 'c1', body: 'Fix it', author: 'octocat' }],
    });
    const github = {
      getCurrentCommitSha: vi.fn().mockResolvedValue('cafe'),
    } as unknown as GitHubClient;
    const { delegate } = makeDelegate();

    await new SeedAwareReviewExecutor({ delegate, logger }).execute(makeContext(github));

    const artifact = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(artifact?.round).toBe(4);
  });
});
