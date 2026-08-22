/**
 * #1164 T012 (FR-008) — re-arm crash-window ownership-label ordering.
 *
 * Defect 4b: `applySuccessDisposition` used to clear the ownership (`agent:*`)
 * labels BEFORE the re-arm `continue` item was enqueued. A crash in that window
 * left the issue with no ownership label AND no queued work — a silent stall.
 *
 * The fix moves the ownership-label clear out of the disposition and into an
 * `afterEnqueue` closure carried on the rearm `postComplete`, which the
 * dispatcher invokes only AFTER `enqueueIfAbsent` resolves. This test pins the
 * WORKER half of that contract: on a re-armed merge-conflict outcome, the
 * worker attaches an `afterEnqueue` closure that clears `agent:in-progress` +
 * `agent:paused`, and does NOT clear them during `handle()` itself.
 *
 * The complementary handler-side claim — that `applySuccessDisposition` no
 * longer clears the ownership labels — is pinned authoritatively by
 * `merge-conflict-handler.success-disposition.test.ts` (T011), which drives the
 * real handler through a resolved conflict and asserts the combined
 * `removeLabels` batch excludes `agent:in-progress` / `agent:paused`.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCliWorker } from '../claude-cli-worker.js';
import type { WorkerConfig } from '../config.js';
import type { ProcessFactory, Logger } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { CompletedResult } from '../worker-result.js';
import type { HandlerOutcome } from '../handler-outcome.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
const mockGithub = {
  removeLabels: vi.fn().mockResolvedValue(undefined),
  addLabels: vi.fn().mockResolvedValue(undefined),
  getIssue: vi.fn().mockResolvedValue({ labels: [], assignees: [] }),
};

vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(() => mockGithub),
  createFeature: vi.fn(),
  registerProcessLauncher: vi.fn(),
  clearProcessLauncher: vi.fn(),
  resolveIssueBranch: vi.fn().mockResolvedValue(null),
  simpleGit: vi.fn(() => ({})),
  WORKFLOW_LABELS: [],
}));

vi.mock('../repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({
    ensureCheckout: vi.fn().mockResolvedValue('/tmp/test-checkout'),
    getDefaultBranch: vi.fn().mockResolvedValue('develop'),
    switchBranch: vi.fn().mockResolvedValue(undefined),
  })),
}));

// The pause-context sidecar carries the interrupted phase in-band. Provide a
// resolved read so the worker routes into the re-arm branch (absence would send
// the handler down the fail-loud path).
vi.mock('../pause-context.js', () => ({
  readPauseContext: vi
    .fn()
    .mockResolvedValue({ phase: 'validate', writtenAt: new Date().toISOString() }),
  clearPauseContext: vi.fn().mockResolvedValue(undefined),
}));

// Stub the handler so this worker-level test controls the outcome directly —
// the real handler's success path is exercised by T011. Resolve a re-armed
// outcome (whole-branch fallback: no reviewScope) so the worker builds the
// rearm `postComplete` + `afterEnqueue` closure.
const mockHandle = vi.fn<[], Promise<HandlerOutcome>>().mockResolvedValue({
  outcome: 're-armed',
  startPhase: 'validate',
});

vi.mock('../merge-conflict-handler.js', () => ({
  MergeConflictHandler: vi.fn().mockImplementation(() => ({ handle: mockHandle })),
}));

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp/test-workspaces',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    gates: {},
    ...overrides,
  } as WorkerConfig;
}

function createQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    owner: 'test-owner',
    repo: 'test-repo',
    issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'resolve-merge-conflicts',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
    ...overrides,
  } as QueueItem;
}

const noopFactory: ProcessFactory = {
  spawn: vi.fn(),
} as unknown as ProcessFactory;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('#1164 merge-conflict re-arm — crash-window ownership-label ordering (FR-008)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithub.removeLabels.mockResolvedValue(undefined);
    mockHandle.mockResolvedValue({ outcome: 're-armed', startPhase: 'validate' });
  });

  it('attaches an afterEnqueue closure to the rearm postComplete and does NOT clear ownership labels during handle()', async () => {
    const worker = new ClaudeCliWorker(createConfig(), mockLogger, {
      processFactory: noopFactory,
    });

    const result = (await worker.handle(createQueueItem())) as CompletedResult;

    expect(result.status).toBe('completed');
    expect(result.postComplete?.kind).toBe('rearm');
    expect(typeof result.postComplete?.afterEnqueue).toBe('function');

    // The ownership labels must NOT have been cleared yet — that is deferred to
    // the dispatcher's post-enqueue invocation of afterEnqueue.
    const clearedBeforeEnqueue = mockGithub.removeLabels.mock.calls.some((c) => {
      const labels = c[3] as string[] | undefined;
      return (
        Array.isArray(labels) &&
        (labels.includes('agent:in-progress') || labels.includes('agent:paused'))
      );
    });
    expect(clearedBeforeEnqueue).toBe(false);
  });

  it('clears exactly agent:in-progress + agent:paused when afterEnqueue is invoked', async () => {
    const worker = new ClaudeCliWorker(createConfig(), mockLogger, {
      processFactory: noopFactory,
    });

    const result = (await worker.handle(createQueueItem())) as CompletedResult;

    // Nothing cleared yet.
    expect(mockGithub.removeLabels).not.toHaveBeenCalled();

    if (result.postComplete?.kind !== 'rearm' || !result.postComplete.afterEnqueue) {
      throw new Error('expected a rearm postComplete carrying afterEnqueue');
    }

    await result.postComplete.afterEnqueue();

    expect(mockGithub.removeLabels).toHaveBeenCalledTimes(1);
    expect(mockGithub.removeLabels).toHaveBeenCalledWith('test-owner', 'test-repo', 42, [
      'agent:in-progress',
      'agent:paused',
    ]);
  });

  it('carries the rearm continue item alongside afterEnqueue', async () => {
    const worker = new ClaudeCliWorker(createConfig(), mockLogger, {
      processFactory: noopFactory,
    });

    const result = (await worker.handle(createQueueItem())) as CompletedResult;

    if (result.postComplete?.kind !== 'rearm') {
      throw new Error('expected a rearm postComplete');
    }
    expect(result.postComplete.rearmItem.command).toBe('continue');
    expect(result.postComplete.rearmItem.issueNumber).toBe(42);
    expect(result.postComplete.rearmItem.metadata?.startPhase).toBe('validate');
  });
});
