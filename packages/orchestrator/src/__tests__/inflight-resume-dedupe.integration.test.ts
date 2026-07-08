import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LabelMonitorService } from '../services/label-monitor-service.js';
import { InMemoryQueueAdapter } from '../services/in-memory-queue-adapter.js';
import type { LabelEvent, PhaseTracker } from '../types/index.js';
import type { MonitorConfig, RepositoryConfig } from '../config/schema.js';

/**
 * Integration test for the in-flight-keyed resume dedupe (#862).
 *
 * Regression scenarios per specs/862-found-during-cockpit-v1/contracts/label-monitor.md
 * § "Test-visible behaviors":
 *
 *   Scenario 1 (kept-green from #849): pause → resume → re-pause → resume.
 *     Both resumes must enqueue because the first was claimed + completed
 *     between them, freeing the in-flight SET.
 *
 *   Scenario 2 (this #862 case): fresh queue, no residual keys. A
 *     `completed:<gate>` resume enqueues. After claim+complete, a second
 *     `completed:<gate>` still enqueues. Under old paired-clear semantics
 *     this scenario required a paired-clear callback to fire; now it works
 *     by construction because there is no resume:<gate> key to survive.
 *
 *   Scenario 3 (SC-003 — webhook+poll race): two concurrent processLabelEvent
 *     calls for the same itemKey on the same completed:<gate> occurrence
 *     collapse to exactly one enqueue.
 */

function makeResumeEvent(source: 'webhook' | 'poll'): LabelEvent {
  return {
    type: 'resume',
    owner: 'test-org',
    repo: 'test-repo',
    issueNumber: 42,
    labelName: 'completed:implementation-review',
    parsedName: 'implementation-review',
    source,
    issueLabels: [
      'completed:implementation-review',
      'waiting-for:implementation-review',
      'workflow:speckit-feature',
    ],
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createNoopPhaseTracker(): PhaseTracker {
  return {
    isDuplicate: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    tryMarkProcessed: vi.fn().mockResolvedValue(true),
  };
}

const config: MonitorConfig = {
  pollIntervalMs: 30000,
  adaptivePolling: false,
  maxConcurrentPolls: 1,
};

const repos: RepositoryConfig[] = [{ owner: 'test-org', repo: 'test-repo' }];

describe('in-flight-keyed resume dedupe (integration)', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let queue: InMemoryQueueAdapter;
  let phaseTracker: PhaseTracker;
  let service: LabelMonitorService;

  beforeEach(() => {
    logger = createMockLogger();
    queue = new InMemoryQueueAdapter(logger);
    phaseTracker = createNoopPhaseTracker();
    const mockGithubClient = {
      getIssue: vi.fn().mockResolvedValue({
        body: 'issue body',
        title: 'issue title',
        labels: [],
      }),
    };
    const clientFactory = vi.fn().mockReturnValue(mockGithubClient);
    service = new LabelMonitorService(
      logger,
      clientFactory,
      phaseTracker,
      queue,
      config,
      repos,
    );
  });

  it('Scenario 1: pause → resume → (claim+complete) → re-pause → resume — both resumes enqueue', async () => {
    // First resume cycle.
    const first = await service.processLabelEvent(makeResumeEvent('webhook'));
    expect(first).toBe(true);
    expect(await queue.getQueueDepth()).toBe(1);

    // Simulate the worker claiming and completing the item — SET drains.
    const claimed1 = await queue.claim('worker-1');
    expect(claimed1).not.toBeNull();
    await queue.complete('worker-1', claimed1!);
    expect(await queue.getQueueDepth()).toBe(0);
    expect(await queue.hasInFlight('test-org/test-repo#42')).toBe(false);

    // Second resume cycle (post-completion, e.g. after re-pause on the next gate).
    const second = await service.processLabelEvent(makeResumeEvent('poll'));
    expect(second).toBe(true);
    expect(await queue.getQueueDepth()).toBe(1);
  });

  it('Scenario 2: no residual keys — fresh completed:<gate> after prior lifecycle enqueues cleanly', async () => {
    // Under the old design, a leftover `phase-tracker:...:resume:<gate>` key
    // could block re-enqueue. Under the new design, no such key exists. Prove
    // it by asserting the phaseTracker is never touched on the resume path.
    const result = await service.processLabelEvent(makeResumeEvent('webhook'));
    expect(result).toBe(true);

    expect(phaseTracker.isDuplicate).not.toHaveBeenCalled();
    expect(phaseTracker.markProcessed).not.toHaveBeenCalled();
    expect(phaseTracker.clear).not.toHaveBeenCalled();

    // Drain and re-fire — second enqueue must succeed with no manual key DEL.
    const claimed = await queue.claim('worker-1');
    await queue.complete('worker-1', claimed!);

    const second = await service.processLabelEvent(makeResumeEvent('poll'));
    expect(second).toBe(true);
    expect(phaseTracker.isDuplicate).not.toHaveBeenCalled();
    expect(phaseTracker.markProcessed).not.toHaveBeenCalled();
  });

  it('Scenario 3 (SC-003): concurrent webhook+poll for same occurrence → exactly one enqueue', async () => {
    const [aResult, bResult] = await Promise.all([
      service.processLabelEvent(makeResumeEvent('webhook')),
      service.processLabelEvent(makeResumeEvent('poll')),
    ]);

    // Exactly one call returns true, the other false.
    const results = [aResult, bResult].sort();
    expect(results).toEqual([false, true]);
    expect(await queue.getQueueDepth()).toBe(1);
  });

  it('Scenario 3: drop-line format matches the D6 contract', async () => {
    // Prime the SET with an in-flight item so the next call drops.
    await service.processLabelEvent(makeResumeEvent('webhook'));
    logger.info.mockClear();

    const result = await service.processLabelEvent(makeResumeEvent('poll'));

    expect(result).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'test-org/test-repo#42',
        gate: 'implementation-review',
        reason: 'in-flight',
        source: 'poll',
      }),
      'Dropping resume event (item already in flight)',
    );
  });
});
