/**
 * FR-006 regression coverage — WorkerDispatcher must complete (NOT release)
 * items whose handler returns `{ status: 'failed-terminal' }`, and must invoke
 * the `terminalFailureHandler` callback before completing.
 *
 * Also asserts:
 * - Handler-returned `{ status: 'completed' }` → queue.complete only.
 * - Handler throws (non-terminal) → queue.release (unchanged behavior).
 * - `terminalFailureHandler` throwing does NOT prevent queue.complete.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WorkerDispatcher } from '../worker-dispatcher.js';
import type { QueueItem, QueueManager, WorkerHandler } from '../../types/index.js';
import type { DispatchConfig } from '../../config/index.js';
import type { FailureMetadata } from '../../worker/worker-result.js';

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
    issueNumber: 889,
    workflowName: 'speckit-feature',
    command: 'process',
    priority: 1,
    enqueuedAt: new Date().toISOString(),
  };
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
    complete: vi.fn().mockResolvedValue(undefined),
    enqueue: vi.fn().mockResolvedValue(undefined),
    getQueueDepth: vi.fn().mockResolvedValue(0),
    getQueueItems: vi.fn().mockResolvedValue([]),
    getActiveWorkerCount: vi.fn().mockResolvedValue(0),
    enqueueIfAbsent: vi.fn().mockResolvedValue(true),
    hasInFlight: vi.fn().mockResolvedValue(false),
  } as unknown as QueueManager & Record<string, any>;
}

async function runDispatcherOnce(dispatcher: WorkerDispatcher): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (dispatcher as any).pollOnce();
  // Wait for the fire-and-forget worker promise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workers = Array.from(((dispatcher as any).activeWorkers as Map<string, any>).values());
  await Promise.all(workers.map((w) => w.promise));
}

describe('WorkerDispatcher terminal-failure branch (FR-006)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();
  });

  it('on failed-terminal: invokes terminalFailureHandler and calls complete (never release)', async () => {
    const queue = createQueue();
    const failureMetadata: FailureMetadata = {
      site: 'gate-hit',
      labelOp: 'addLabels([waiting-for:merge-conflicts, agent:paused])',
      ghStderr: "could not add label: 'waiting-for:merge-conflicts' not found",
    };
    const handler: WorkerHandler = vi.fn().mockResolvedValue({
      status: 'failed-terminal',
      failureMetadata,
    });
    const terminalFailureHandler = vi.fn().mockResolvedValue(undefined);

    const dispatcher = new WorkerDispatcher(
      queue,
      null,
      mockLogger as any,
      createConfig(),
      handler,
      undefined,
      terminalFailureHandler,
    );

    await runDispatcherOnce(dispatcher);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(terminalFailureHandler).toHaveBeenCalledTimes(1);
    expect(terminalFailureHandler).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 889 }),
      failureMetadata,
    );
    expect(queue.complete).toHaveBeenCalledTimes(1);
    expect(queue.release).not.toHaveBeenCalled();
  });

  it('on completed: calls complete only (unchanged behavior)', async () => {
    const queue = createQueue();
    const handler: WorkerHandler = vi.fn().mockResolvedValue({ status: 'completed' });
    const terminalFailureHandler = vi.fn().mockResolvedValue(undefined);

    const dispatcher = new WorkerDispatcher(
      queue,
      null,
      mockLogger as any,
      createConfig(),
      handler,
      undefined,
      terminalFailureHandler,
    );

    await runDispatcherOnce(dispatcher);

    expect(terminalFailureHandler).not.toHaveBeenCalled();
    expect(queue.complete).toHaveBeenCalledTimes(1);
    expect(queue.release).not.toHaveBeenCalled();
  });

  it('on unhandled throw: releases (unchanged generic-error behavior)', async () => {
    const queue = createQueue();
    const handler: WorkerHandler = vi.fn().mockRejectedValue(new Error('network hiccup'));

    const dispatcher = new WorkerDispatcher(
      queue,
      null,
      mockLogger as any,
      createConfig(),
      handler,
    );

    await runDispatcherOnce(dispatcher);

    expect(queue.release).toHaveBeenCalledTimes(1);
    expect(queue.complete).not.toHaveBeenCalled();
  });

  it('terminalFailureHandler throwing does not prevent queue.complete', async () => {
    const queue = createQueue();
    const failureMetadata: FailureMetadata = {
      site: 'gate-hit',
      labelOp: 'addLabels([x])',
      ghStderr: 'boom',
    };
    const handler: WorkerHandler = vi.fn().mockResolvedValue({
      status: 'failed-terminal',
      failureMetadata,
    });
    const terminalFailureHandler = vi.fn().mockRejectedValue(new Error('alert post failed'));

    const dispatcher = new WorkerDispatcher(
      queue,
      null,
      mockLogger as any,
      createConfig(),
      handler,
      undefined,
      terminalFailureHandler,
    );

    await runDispatcherOnce(dispatcher);

    // Complete must still fire — no crash-loop
    expect(queue.complete).toHaveBeenCalledTimes(1);
    expect(queue.release).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('terminalFailureHandler threw'),
    );
  });
});
