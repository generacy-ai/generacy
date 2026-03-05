import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerDispatcher } from '../../../src/services/worker-dispatcher.js';
import type {
  QueueManager,
  QueueItem,
  WorkerHandler,
} from '../../../src/types/index.js';
import type { DispatchConfig } from '../../../src/config/index.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockQueueManager(
  overrides: Partial<QueueManager> = {},
): QueueManager {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue(null),
    release: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    getQueueDepth: vi.fn().mockResolvedValue(0),
    getQueueItems: vi.fn().mockResolvedValue([]),
    getActiveWorkerCount: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function createMockRedis(
  overrides: Record<string, unknown> = {},
) {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    exists: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as import('ioredis').Redis;
}

const sampleItem: QueueItem = {
  owner: 'test-org',
  repo: 'test-repo',
  issueNumber: 42,
  workflowName: 'speckit-feature',
  command: 'process' as const,
  priority: 1000,
  enqueuedAt: '2024-01-01T00:00:00Z',
};

// Use very short intervals so tests run fast with real timers
const testConfig: DispatchConfig = {
  pollIntervalMs: 10,
  heartbeatTtlMs: 200,
  heartbeatCheckIntervalMs: 20,
  shutdownTimeoutMs: 100,
  maxRetries: 3,
};

/** Wait for a short period to let poll/reaper ticks happen */
function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WorkerDispatcher', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let queue: QueueManager;
  let redis: ReturnType<typeof createMockRedis>;
  let handler: ReturnType<typeof vi.fn<WorkerHandler>>;
  let dispatcher: WorkerDispatcher;

  beforeEach(() => {
    logger = createMockLogger();
    queue = createMockQueueManager();
    redis = createMockRedis();
    handler = vi.fn<WorkerHandler>().mockResolvedValue(undefined);
    dispatcher = new WorkerDispatcher(queue, redis, logger, testConfig, handler);
  });

  afterEach(async () => {
    if (dispatcher.isRunning()) {
      await dispatcher.stop();
    }
  });

  describe('start()', () => {
    it('should set isRunning to true when started', async () => {
      expect(dispatcher.isRunning()).toBe(false);

      const startPromise = dispatcher.start();
      await tick();

      expect(dispatcher.isRunning()).toBe(true);

      await dispatcher.stop();
      await startPromise;
    });

    it('should warn and return if already running', async () => {
      const startPromise = dispatcher.start();
      await tick();

      // Try to start again
      await dispatcher.start();

      expect(logger.warn).toHaveBeenCalledWith(
        'Worker dispatcher already running',
      );

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('poll loop', () => {
    it('should claim from queue and dispatch to handler', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      const startPromise = dispatcher.start();
      await tick();

      expect(queue.claim).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: sampleItem.owner,
          repo: sampleItem.repo,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      await dispatcher.stop();
      await startPromise;
    });

    it('should not dispatch handler when queue is empty', async () => {
      (queue.claim as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const startPromise = dispatcher.start();
      await tick();

      expect(queue.claim).toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('concurrency limit', () => {
    it('should not claim when already processing a job', async () => {
      const blockers: Array<{ resolve: () => void }> = [];

      handler.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            blockers.push({ resolve });
          }),
      );

      // Each claim returns a unique item
      let claimCount = 0;
      (queue.claim as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        claimCount++;
        return { ...sampleItem, issueNumber: claimCount };
      });

      const startPromise = dispatcher.start();

      // Wait long enough for several poll cycles
      await tick(100);

      // Only one job should be active at a time (1 per container)
      expect(dispatcher.getActiveWorkerCount()).toBe(1);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          active: 1,
        }),
        'Already processing a job, skipping claim',
      );

      // Resolve all blockers to allow cleanup
      for (const blocker of blockers) {
        blocker.resolve();
      }

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('handler success', () => {
    it('should call queue.complete when handler resolves', async () => {
      const item = { ...sampleItem };
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(item)
        .mockResolvedValue(null);

      handler.mockResolvedValue(undefined);

      const startPromise = dispatcher.start();
      await tick();

      expect(queue.complete).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: item.owner,
          issueNumber: item.issueNumber,
        }),
      );

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('handler failure', () => {
    it('should call queue.release when handler rejects', async () => {
      const item = { ...sampleItem };
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(item)
        .mockResolvedValue(null);

      handler.mockRejectedValue(new Error('handler failed'));

      const startPromise = dispatcher.start();
      await tick();

      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: item.owner,
          issueNumber: item.issueNumber,
        }),
      );
      expect(queue.complete).not.toHaveBeenCalled();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          owner: item.owner,
          issue: item.issueNumber,
        }),
        'Worker failed, item released back to queue',
      );

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('stop()', () => {
    it('should set isRunning to false after stop', async () => {
      const startPromise = dispatcher.start();
      await tick();

      expect(dispatcher.isRunning()).toBe(true);

      await dispatcher.stop();
      await startPromise;

      expect(dispatcher.isRunning()).toBe(false);
    });

    it('should be a no-op when not running', async () => {
      await dispatcher.stop();
      expect(logger.info).not.toHaveBeenCalledWith('Stopping worker dispatcher');
    });

    it('should release remaining items when shutdown timeout expires', async () => {
      // Handler that never resolves (stuck worker)
      handler.mockImplementation(() => new Promise<void>(() => {}));

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      const startPromise = dispatcher.start();
      await tick();

      expect(dispatcher.getActiveWorkerCount()).toBe(1);

      // stop() will wait shutdownTimeoutMs (100ms) then release
      await dispatcher.stop();
      await startPromise;

      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: sampleItem.owner,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: expect.any(String) }),
        'Released worker item during shutdown',
      );
    });
  });

  describe('reaper label cleanup', () => {
    it('calls labelCleanup when heartbeat expires', async () => {
      const labelCleanup = vi.fn<(owner: string, repo: string, issueNumber: number) => Promise<void>>()
        .mockResolvedValue(undefined);

      dispatcher = new WorkerDispatcher(queue, redis, logger, testConfig, handler, labelCleanup);

      // Handler that never resolves so the worker stays active
      handler.mockImplementation(() => new Promise<void>(() => {}));

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Heartbeat disappears after first check
      (redis.exists as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(1)
        .mockResolvedValue(0);

      const startPromise = dispatcher.start();
      await tick(100);

      expect(labelCleanup).toHaveBeenCalledWith(
        sampleItem.owner,
        sampleItem.repo,
        sampleItem.issueNumber,
      );

      // Queue item should still be released after label cleanup
      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: sampleItem.owner,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      await dispatcher.stop();
      await startPromise;
    });

    it('continues reaping if labelCleanup throws', async () => {
      const labelCleanup = vi.fn<(owner: string, repo: string, issueNumber: number) => Promise<void>>()
        .mockRejectedValue(new Error('GitHub API unavailable'));

      dispatcher = new WorkerDispatcher(queue, redis, logger, testConfig, handler, labelCleanup);

      // Handler that never resolves so the worker stays active
      handler.mockImplementation(() => new Promise<void>(() => {}));

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Heartbeat disappears after first check
      (redis.exists as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(1)
        .mockResolvedValue(0);

      const startPromise = dispatcher.start();
      await tick(100);

      // labelCleanup was called but threw
      expect(labelCleanup).toHaveBeenCalledWith(
        sampleItem.owner,
        sampleItem.repo,
        sampleItem.issueNumber,
      );

      // Error should be logged at warn level (non-fatal)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          workerId: expect.any(String),
        }),
        'Failed to clean up labels during reap (non-fatal)',
      );

      // Queue item should still be released despite labelCleanup failure
      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: sampleItem.owner,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      // Worker should be removed from activeWorkers
      expect(dispatcher.getActiveWorkerCount()).toBe(0);

      await dispatcher.stop();
      await startPromise;
    });

    it('works without labelCleanup callback (backward-compatible)', async () => {
      // Construct without labelCleanup (default from beforeEach)
      // dispatcher already created without labelCleanup in beforeEach

      // Handler that never resolves so the worker stays active
      handler.mockImplementation(() => new Promise<void>(() => {}));

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Heartbeat disappears after first check
      (redis.exists as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(1)
        .mockResolvedValue(0);

      const startPromise = dispatcher.start();
      await tick(100);

      // Reaper should still work: log the stale worker
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: expect.any(String),
        }),
        'Reaping stale worker (heartbeat expired)',
      );

      // Queue item should be released
      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: sampleItem.owner,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      // Worker should be removed from activeWorkers
      expect(dispatcher.getActiveWorkerCount()).toBe(0);

      // No label cleanup warning should appear (no callback provided)
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        'Failed to clean up labels during reap (non-fatal)',
      );

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('reaper', () => {
    it('should release items whose heartbeat has expired', async () => {
      // Handler that never resolves so the worker stays active
      handler.mockImplementation(() => new Promise<void>(() => {}));

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Heartbeat disappears after first check
      (redis.exists as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(1)
        .mockResolvedValue(0);

      const startPromise = dispatcher.start();

      // Wait for poll + a couple reaper cycles
      await tick(100);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: expect.any(String),
        }),
        'Reaping stale worker (heartbeat expired)',
      );

      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: sampleItem.owner,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('heartbeat', () => {
    it('should refresh heartbeat via redis.set', async () => {
      let resolveHandler!: () => void;
      handler.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveHandler = resolve;
          }),
      );

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      const startPromise = dispatcher.start();

      // Wait for poll + heartbeat interval (ttl/2 = 100ms)
      await tick(150);

      expect(redis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^orchestrator:worker:.+:heartbeat$/),
        '1',
        'EX',
        expect.any(Number),
      );

      resolveHandler();
      await tick();

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('getActiveWorkerCount()', () => {
    it('should return 0 when no workers are active', () => {
      expect(dispatcher.getActiveWorkerCount()).toBe(0);
    });
  });

  describe('poll loop error handling', () => {
    it('should log errors and continue polling', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Redis timeout'))
        .mockResolvedValue(null);

      const startPromise = dispatcher.start();
      await tick();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Error during poll cycle',
      );

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('in-memory heartbeat (null Redis)', () => {
    let memDispatcher: WorkerDispatcher;

    beforeEach(() => {
      memDispatcher = new WorkerDispatcher(queue, null, logger, testConfig, handler);
    });

    afterEach(async () => {
      if (memDispatcher.isRunning()) {
        await memDispatcher.stop();
      }
    });

    it('should dispatch workers without Redis', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      handler.mockResolvedValue(undefined);

      const startPromise = memDispatcher.start();
      await tick();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: sampleItem.owner,
          repo: sampleItem.repo,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      expect(queue.complete).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ owner: sampleItem.owner }),
      );

      await memDispatcher.stop();
      await startPromise;
    });

    it('should keep workers alive via in-memory heartbeat', async () => {
      let resolveHandler!: () => void;
      handler.mockImplementation(
        () => new Promise<void>((resolve) => { resolveHandler = resolve; }),
      );

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      const startPromise = memDispatcher.start();

      // Wait for poll + several reaper cycles (heartbeat refreshes at ttl/2 = 100ms)
      await tick(150);

      // Worker should still be active (heartbeat kept alive by interval)
      expect(memDispatcher.getActiveWorkerCount()).toBe(1);

      // No reaping should have happened
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'Reaping stale worker (heartbeat expired)',
      );

      resolveHandler();
      await tick();

      await memDispatcher.stop();
      await startPromise;
    });

    it('should release items when handler fails without Redis', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      handler.mockRejectedValue(new Error('handler failed'));

      const startPromise = memDispatcher.start();
      await tick();

      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ owner: sampleItem.owner }),
      );

      await memDispatcher.stop();
      await startPromise;
    });
  });
});
