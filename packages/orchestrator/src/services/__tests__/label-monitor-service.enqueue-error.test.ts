/**
 * #1060 PR #1065 review finding 4 — regression suite for the discriminated
 * enqueue-outcome handling on the `type: 'process'` path.
 *
 * Contract: `QueueManager.enqueue()` throws on transport error. The
 * label-monitor caller MUST wrap the call and, on error, skip
 * `phaseTracker.markProcessed()` so the next poll retries.
 *
 * Regression pinned: previously `enqueue()` swallowed Redis errors and
 * returned `false`, which the caller treated identically to "already in
 * flight" — proceeding to `markProcessed()`. On a Redis blip the intake
 * was permanently dropped: pending never got the item AND the phase
 * tracker was marked processed, so the next poll's `isDuplicate` gate
 * skipped it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LabelMonitorService } from '../label-monitor-service.js';
import type { LabelEvent, PhaseTracker, QueueManager } from '../../types/monitor.js';
import type { MonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { GitHubClientFactory } from '@generacy-ai/workflow-engine';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createPhaseTracker(): PhaseTracker & { markProcessed: ReturnType<typeof vi.fn> } {
  return {
    isDuplicate: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    tryMarkProcessed: vi.fn().mockResolvedValue(true),
    isDuplicateRaw: vi.fn().mockResolvedValue(false),
    markProcessedRaw: vi.fn().mockResolvedValue(undefined),
  };
}

function createGithubFactory(): GitHubClientFactory {
  const client = {
    getIssue: vi.fn().mockResolvedValue({
      number: 1060,
      title: 'test',
      body: 'test',
      state: 'open',
      labels: [],
      assignees: [],
      created_at: '2026-07-28T00:00:00Z',
      updated_at: '2026-07-28T00:00:00Z',
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
  };
  return vi.fn(() => client) as unknown as GitHubClientFactory;
}

function makeConfig(): MonitorConfig {
  return {
    pollIntervalMs: 60000,
    adaptivePolling: false,
    maxConcurrentPolls: 1,
  };
}

const repos: RepositoryConfig[] = [{ owner: 'generacy-ai', repo: 'generacy' }];

function makeEvent(): LabelEvent {
  return {
    type: 'process',
    owner: 'generacy-ai',
    repo: 'generacy',
    issueNumber: 1060,
    labelName: 'process:speckit-feature',
    parsedName: 'speckit-feature',
    source: 'poll',
    issueLabels: ['process:speckit-feature'],
  };
}

describe('LabelMonitorService.processLabelEvent — enqueue error handling (#1060 PR #1065 finding 4)', () => {
  let logger: ReturnType<typeof createLogger>;
  let phaseTracker: ReturnType<typeof createPhaseTracker>;
  let queueManager: QueueManager & {
    enqueue: ReturnType<typeof vi.fn>;
    enqueueIfAbsent: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    logger = createLogger();
    phaseTracker = createPhaseTracker();
    queueManager = {
      enqueue: vi.fn().mockResolvedValue(true),
      enqueueIfAbsent: vi.fn().mockResolvedValue(true),
      hasInFlight: vi.fn().mockResolvedValue(false),
      claim: vi.fn().mockResolvedValue(null),
      release: vi.fn().mockResolvedValue(undefined),
      requeueForResume: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      getQueueDepth: vi.fn().mockResolvedValue(0),
      getQueueItems: vi.fn().mockResolvedValue([]),
      getActiveWorkerCount: vi.fn().mockResolvedValue(0),
      reapOrphanClaims: vi.fn().mockResolvedValue({
        scanned: 0,
        reclaimed: [],
        skippedRaceReappeared: 0,
        skippedGraceWindow: 0,
      }),
      hasInFlightAge: vi.fn().mockResolvedValue(null),
    } as unknown as QueueManager & {
      enqueue: ReturnType<typeof vi.fn>;
      enqueueIfAbsent: ReturnType<typeof vi.fn>;
    };
  });

  function makeService() {
    return new LabelMonitorService(
      logger,
      createGithubFactory(),
      phaseTracker,
      queueManager,
      makeConfig(),
      repos,
    );
  }

  it('SUCCESS: enqueue returns true → markProcessed is called', async () => {
    queueManager.enqueue.mockResolvedValue(true);
    const service = makeService();

    const result = await service.processLabelEvent(makeEvent());

    expect(result).toBe(true);
    expect(queueManager.enqueue).toHaveBeenCalledOnce();
    expect(phaseTracker.markProcessed).toHaveBeenCalledOnce();
  });

  it('ALREADY-IN-FLIGHT: enqueue returns false → markProcessed IS called (dedup intent satisfied)', async () => {
    queueManager.enqueue.mockResolvedValue(false);
    const service = makeService();

    const result = await service.processLabelEvent(makeEvent());

    expect(result).toBe(true);
    // The intent (this issue's phase-N run is claimed) is already true —
    // safe and correct to mark processed so the next poll doesn't refire.
    expect(phaseTracker.markProcessed).toHaveBeenCalledOnce();
  });

  it('TRANSPORT-ERROR: enqueue throws → markProcessed is NOT called (next poll retries)', async () => {
    // The core regression: previously enqueue() swallowed and returned
    // false, which the caller treated identically to "already in
    // flight" — proceeding to markProcessed. On a Redis blip the intake
    // was permanently dropped (pending never got the item AND the phase
    // tracker was marked processed, so the next poll skipped it).
    queueManager.enqueue.mockRejectedValue(new Error('Connection refused'));
    const service = makeService();

    const result = await service.processLabelEvent(makeEvent());

    expect(result).toBe(false);
    expect(queueManager.enqueue).toHaveBeenCalledOnce();
    // Crucially: NOT marked processed. The next poll's isDuplicate gate
    // will return false and the event will be re-attempted.
    expect(phaseTracker.markProcessed).not.toHaveBeenCalled();
    // Structured warn line documents the retry path.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'generacy-ai',
        repo: 'generacy',
        issueNumber: 1060,
        workflowName: 'speckit-feature',
      }),
      'Queue enqueue errored — leaving dedup state unmarked so the next poll retries',
    );
  });
});
