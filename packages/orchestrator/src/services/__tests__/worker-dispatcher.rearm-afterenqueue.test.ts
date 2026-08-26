/**
 * #1164 T013 (FR-008 / SC-005) — dispatcher rearm `afterEnqueue` ordering.
 *
 * Defect 4b: the ownership (`agent:*`) labels used to be cleared inside the
 * merge-conflict handler's `applySuccessDisposition`, BEFORE the re-arm
 * `continue` item was enqueued. A crash in that window left the issue with no
 * ownership label AND no queued work — a silent stall.
 *
 * The fix carries an `afterEnqueue` closure on the rearm `postComplete` (built
 * by the worker, which holds the `GitHubClient`; the dispatcher has none in
 * worker mode). This test pins the DISPATCHER half of the contract: the closure
 * runs STRICTLY AFTER `enqueueIfAbsent` resolves, on BOTH the enqueued
 * (`true`) and dropped (`false`) outcomes, and is NOT run when
 * `enqueueIfAbsent` throws (so ownership labels survive for the next poll).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WorkerDispatcher } from '../worker-dispatcher.js';
import type { QueueItem, QueueManager, WorkerHandler } from '../../types/index.js';
import type { DispatchConfig } from '../../config/index.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

function createItem(): QueueItem {
  return {
    owner: 'test-owner',
    repo: 'test-repo',
    issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'resolve-merge-conflicts',
    priority: 1,
    enqueuedAt: new Date().toISOString(),
  };
}

function createRearmItem(): QueueItem {
  return {
    owner: 'test-owner',
    repo: 'test-repo',
    issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'continue',
    priority: 1,
    enqueuedAt: new Date().toISOString(),
    metadata: { startPhase: 'validate' },
  } as unknown as QueueItem;
}

function createConfig(): DispatchConfig {
  return {
    pollIntervalMs: 60_000,
    heartbeatTtlMs: 30_000,
    heartbeatCheckIntervalMs: 30_000,
    shutdownTimeoutMs: 5_000,
    maxRetries: 3,
  } as DispatchConfig;
}

function createQueue() {
  const item = createItem();
  return {
    claim: vi.fn().mockResolvedValueOnce(item).mockResolvedValue(null),
    release: vi.fn().mockResolvedValue(undefined),
    requeueForResume: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    enqueue: vi.fn().mockResolvedValue(undefined),
    getQueueDepth: vi.fn().mockResolvedValue(0),
    getQueueItems: vi.fn().mockResolvedValue([]),
    getActiveWorkerCount: vi.fn().mockResolvedValue(0),
    enqueueIfAbsent: vi.fn().mockResolvedValue(true),
    hasInFlight: vi.fn().mockResolvedValue(false),
    reapOrphanClaims: vi.fn().mockResolvedValue({
      scanned: 0,
      reclaimed: [],
      skippedRaceReappeared: 0,
      skippedGraceWindow: 0,
    }),
    hasInFlightAge: vi.fn().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as QueueManager & Record<string, any>;
}

async function runDispatcherOnce(dispatcher: WorkerDispatcher): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (dispatcher as any).pollOnce();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workers = Array.from(((dispatcher as any).activeWorkers as Map<string, any>).values());
  await Promise.all(workers.map((w) => w.promise));
}

describe('#1164 WorkerDispatcher rearm afterEnqueue ordering (FR-008)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();
  });

  it('invokes afterEnqueue STRICTLY AFTER enqueueIfAbsent on the enqueued (true) outcome', async () => {
    const calls: string[] = [];
    const queue = createQueue();
    (queue.enqueueIfAbsent as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('enqueueIfAbsent');
      return true;
    });
    const afterEnqueue = vi.fn().mockImplementation(async () => {
      calls.push('afterEnqueue');
    });

    const handler: WorkerHandler = vi.fn().mockResolvedValue({
      status: 'completed',
      postComplete: { kind: 'rearm', rearmItem: createRearmItem(), afterEnqueue },
    });

    const dispatcher = new WorkerDispatcher(
      queue,
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockLogger as any,
      createConfig(),
      handler,
    );

    await runDispatcherOnce(dispatcher);

    expect(queue.enqueueIfAbsent).toHaveBeenCalledTimes(1);
    expect(afterEnqueue).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['enqueueIfAbsent', 'afterEnqueue']);
  });

  it('invokes afterEnqueue on the dropped (false / already-in-flight) outcome too', async () => {
    const calls: string[] = [];
    const queue = createQueue();
    (queue.enqueueIfAbsent as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('enqueueIfAbsent');
      return false;
    });
    const afterEnqueue = vi.fn().mockImplementation(async () => {
      calls.push('afterEnqueue');
    });

    const handler: WorkerHandler = vi.fn().mockResolvedValue({
      status: 'completed',
      postComplete: { kind: 'rearm', rearmItem: createRearmItem(), afterEnqueue },
    });

    const dispatcher = new WorkerDispatcher(
      queue,
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockLogger as any,
      createConfig(),
      handler,
    );

    await runDispatcherOnce(dispatcher);

    expect(queue.enqueueIfAbsent).toHaveBeenCalledTimes(1);
    expect(afterEnqueue).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['enqueueIfAbsent', 'afterEnqueue']);
  });

  it('does NOT invoke afterEnqueue when enqueueIfAbsent throws — ownership labels survive', async () => {
    const queue = createQueue();
    (queue.enqueueIfAbsent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('redis down'),
    );
    const afterEnqueue = vi.fn().mockResolvedValue(undefined);

    const handler: WorkerHandler = vi.fn().mockResolvedValue({
      status: 'completed',
      postComplete: { kind: 'rearm', rearmItem: createRearmItem(), afterEnqueue },
    });

    const dispatcher = new WorkerDispatcher(
      queue,
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockLogger as any,
      createConfig(),
      handler,
    );

    await runDispatcherOnce(dispatcher);

    expect(queue.enqueueIfAbsent).toHaveBeenCalledTimes(1);
    expect(afterEnqueue).not.toHaveBeenCalled();
    // Enqueue-threw path completes the source item but leaves pause labels intact.
    expect(queue.complete).toHaveBeenCalledTimes(1);
  });

  it('a rearm postComplete without afterEnqueue still enqueues without error (optional closure)', async () => {
    const queue = createQueue();

    const handler: WorkerHandler = vi.fn().mockResolvedValue({
      status: 'completed',
      postComplete: { kind: 'rearm', rearmItem: createRearmItem() },
    });

    const dispatcher = new WorkerDispatcher(
      queue,
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockLogger as any,
      createConfig(),
      handler,
    );

    await runDispatcherOnce(dispatcher);

    expect(queue.enqueueIfAbsent).toHaveBeenCalledTimes(1);
    expect(queue.complete).toHaveBeenCalledTimes(1);
  });
});
