/**
 * #1126 T016 — integration test for the review-convergence wiring (SC-005).
 *
 * Drives the whole convergence pipeline through the phase loop (not the pure
 * functions in isolation) for the two delta sources that land in this feature:
 *
 *   1. Remediate re-review — a persisted artifact carries `lastReviewedSha`, so
 *      the re-review scopes to `lastReviewedSha..HEAD` and the artifact advances
 *      a monotonic round + `lastReviewedSha`.
 *   2. Merge-conflict resolution — a real pause-context sidecar on disk carries
 *      `resolutionBaseSha`/`resolutionHeadSha`, so the delta scopes to just the
 *      resolution diff (highest-priority base selection, FR-007).
 *
 * Both assert the scoped input excludes unrelated files (the delta call targets
 * the scoped SHAs, never the full-diff base) and that the artifact persists.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, WorkflowPhase } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { PhaseTracker } from '../../types/index.js';
import type { FindingsArtifact } from '../review/index.js';
import { writePauseContext } from '../pause-context.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

type TrackerWithStore = PhaseTracker & { store: Map<string, string> };

function createPhaseTracker(seed: Record<string, string> = {}): TrackerWithStore {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    isDuplicate: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    tryMarkProcessed: vi.fn().mockResolvedValue(true),
    isDuplicateRaw: vi.fn().mockResolvedValue(false),
    markProcessedRaw: vi.fn().mockResolvedValue(undefined),
    getValueRaw: vi.fn(async (key: string) => store.get(key) ?? null),
    setValueRaw: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    clearRaw: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    store,
  } as unknown as TrackerWithStore;
}

function createMockDeps(phaseTracker: PhaseTracker): PhaseLoopDeps {
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
      onGateHit: vi.fn().mockResolvedValue(undefined),
    } as any,
    stageCommentManager: {
      updateStageComment: vi.fn().mockResolvedValue(undefined),
      postFailureAlert: vi.fn().mockResolvedValue(undefined),
    } as any,
    gateChecker: {
      checkGates: vi.fn().mockReturnValue([]),
    } as any,
    cliSpawner: {
      spawnPhase: vi.fn().mockResolvedValue({
        phase: 'implement',
        success: true,
        exitCode: 0,
        durationMs: 100,
        output: [],
      }),
      runValidatePhase: vi.fn().mockResolvedValue({
        phase: 'validate',
        success: true,
        exitCode: 0,
        durationMs: 100,
        output: [],
      }),
      runPreValidateInstall: vi.fn().mockResolvedValue({
        phase: 'validate',
        success: true,
        exitCode: 0,
        durationMs: 100,
        output: [],
      }),
    } as any,
    outputCapture: {
      processChunk: vi.fn(),
      flush: vi.fn(),
      getOutput: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as any,
    prManager: {
      commitPushAndEnsurePr: vi.fn().mockResolvedValue({ prUrl: null, hasChanges: true }),
      getPrNumber: vi.fn().mockReturnValue(undefined),
    } as any,
    phaseTracker,
  };
}

function createMockContext(overrides: Partial<WorkerContext> = {}): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 1126,
      workflowName: 'speckit-feature',
    } as any,
    startPhase: 'review',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('HEAD_SHA'),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['src/a.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['src/a.ts']),
      commitExistsInCheckout: vi.fn().mockResolvedValue(true),
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    // `context.branch` left unset on purpose: the #1051 loop-entry push guard
    // only fires when it is populated, and this test isolates convergence, not
    // push refusal. runReviewConvergence keys the artifact on `no-branch`.
    issueUrl: 'https://github.com/test/repo/issues/1126',
    description: 'test',
    ...overrides,
  };
}

function createConfig(): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    preValidateCommand: '',
    gates: {},
    maxImplementRetries: 2,
    reviewPhaseEnabled: true,
  } as WorkerConfig;
}

const ARTIFACT_KEY = 'review-findings:test:repo:1126:no-branch';

function readPersistedArtifact(tracker: TrackerWithStore): FindingsArtifact {
  const raw = tracker.store.get(ARTIFACT_KEY);
  expect(raw).toBeTruthy();
  return JSON.parse(raw as string) as FindingsArtifact;
}

describe('#1126 PhaseLoop review convergence — remediate re-review (SC-005)', () => {
  let phaseLoop: PhaseLoop;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
  });

  it('scopes the delta to lastReviewedSha..HEAD and advances the artifact', async () => {
    const seedArtifact: FindingsArtifact = {
      round: 1,
      lastReviewedSha: 'LAST',
      findings: [
        {
          id: 'f1',
          severity: 'critical',
          file: 'src/a.ts',
          title: 'Null deref',
          detail: 'derefs before guard',
          round: 1,
          status: 'open',
        },
      ],
    };
    const tracker = createPhaseTracker({ [ARTIFACT_KEY]: JSON.stringify(seedArtifact) });
    const deps = createMockDeps(tracker);
    const context = createMockContext();

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['review']);

    expect(result.completed).toBe(true);

    // Scoped to the last-reviewed window, not the full-diff base.
    expect(context.github.getFilesChangedBetween).toHaveBeenCalledWith('LAST', 'HEAD_SHA');

    // Artifact advanced a monotonic round + lastReviewedSha.
    const next = readPersistedArtifact(tracker);
    expect(next.round).toBe(2);
    expect(next.lastReviewedSha).toBe('HEAD_SHA');
    // The still-open finding is carried forward untouched (reviewer is a stub).
    expect(next.findings.map((f) => f.id)).toEqual(['f1']);
  });

  it('identical last-reviewed and HEAD produce an empty delta (no git diff call)', async () => {
    const seedArtifact: FindingsArtifact = {
      round: 2,
      lastReviewedSha: 'HEAD_SHA',
      findings: [],
    };
    const tracker = createPhaseTracker({ [ARTIFACT_KEY]: JSON.stringify(seedArtifact) });
    const deps = createMockDeps(tracker);
    const context = createMockContext();

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['review']);

    expect(result.completed).toBe(true);
    expect(context.github.getFilesChangedBetween).not.toHaveBeenCalled();

    const next = readPersistedArtifact(tracker);
    expect(next.round).toBe(3);
    expect(next.lastReviewedSha).toBe('HEAD_SHA');
  });
});

describe('#1126 PhaseLoop review convergence — merge-conflict resolution (SC-005)', () => {
  let phaseLoop: PhaseLoop;
  let tmpDir: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-pass-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('scopes the delta to the resolution SHAs, excluding unrelated files (FR-007)', async () => {
    // Write a real pause-context sidecar carrying resolution SHAs.
    await writePauseContext(tmpDir, 'test/repo#1126', {
      phase: 'review',
      writtenAt: new Date().toISOString(),
      issueRef: 'test/repo#1126',
      resolutionBaseSha: 'RBASE',
      resolutionHeadSha: 'RHEAD',
    });

    // A last-reviewed artifact is present too — the resolution SHAs must win.
    const seedArtifact: FindingsArtifact = {
      round: 1,
      lastReviewedSha: 'LAST',
      findings: [],
    };
    const tracker = createPhaseTracker({ [ARTIFACT_KEY]: JSON.stringify(seedArtifact) });
    const deps = createMockDeps(tracker);
    const context = createMockContext({ checkoutPath: tmpDir });
    (context.github.getFilesChangedBetween as any).mockResolvedValue(['src/resolved.ts']);

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['review']);

    expect(result.completed).toBe(true);

    // Highest-priority base selection: the resolution diff, not last-reviewed.
    expect(context.github.getFilesChangedBetween).toHaveBeenCalledWith('RBASE', 'RHEAD');
    // last-reviewed path never consulted when resolution SHAs are present.
    expect(context.github.commitExistsInCheckout).not.toHaveBeenCalled();

    const next = readPersistedArtifact(tracker);
    expect(next.round).toBe(2);
    // Resolution head advances the artifact's lastReviewedSha.
    expect(next.lastReviewedSha).toBe('RHEAD');
  });
});
