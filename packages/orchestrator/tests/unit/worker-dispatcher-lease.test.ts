import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WorkerDispatcher } from '../../src/services/worker-dispatcher.js';
import { LeaseManager } from '../../src/services/lease-manager.js';
import type {
  QueueManager,
  QueueItem,
  WorkerHandler,
} from '../../src/types/index.js';
import type { DispatchConfig } from '../../src/config/index.js';

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

function createMockLeaseManager(overrides: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  const manager = Object.assign(emitter, {
    requestLease: vi.fn().mockResolvedValue({ status: 'granted', leaseId: 'lease-1' }),
    releaseLease: vi.fn(),
    startHeartbeat: vi.fn(),
    handleLeaseResponse: vi.fn(),
    handleSlotAvailable: vi.fn(),
    handleTierInfo: vi.fn(),
    handleClusterRejected: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    userTierLimit: 2,
    isClusterRejected: false,
    activeLeaseCount: 0,
    ...overrides,
  });
  return manager as unknown as LeaseManager;
}

const sampleItem: QueueItem = {
  owner: 'test-org',
  repo: 'test-repo',
  issueNumber: 42,
  workflowName: 'speckit-feature',
  command: 'process' as const,
  priority: 1000,
  enqueuedAt: '2024-01-01T00:00:00Z',
  userId: 'user-123',
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

describe('WorkerDispatcher lease integration', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let queue: QueueManager;
  let handler: ReturnType<typeof vi.fn<WorkerHandler>>;
  let dispatcher: WorkerDispatcher;
  let leaseManager: ReturnType<typeof createMockLeaseManager>;

  beforeEach(() => {
    logger = createMockLogger();
    queue = createMockQueueManager();
    handler = vi.fn<WorkerHandler>().mockResolvedValue(undefined);
    // Use null redis (in-memory heartbeat mode) to avoid Redis mock complexity
    dispatcher = new WorkerDispatcher(queue, null, logger, testConfig, handler);
    leaseManager = createMockLeaseManager();
  });

  afterEach(async () => {
    if (dispatcher.isRunning()) {
      await dispatcher.stop();
    }
  });

  describe('dispatch gated on lease_granted', () => {
    it('should request a lease after claim and run handler on granted', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      (leaseManager.requestLease as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ status: 'granted', leaseId: 'lease-abc' });

      dispatcher.setLeaseManager(leaseManager);

      const startPromise = dispatcher.start();
      await tick();

      // Lease was requested with the correct parameters
      expect(leaseManager.requestLease).toHaveBeenCalledWith(
        'user-123',
        'test-org/test-repo#42',
        'test-org/test-repo#42',
      );

      // Heartbeat was started for the granted lease
      expect(leaseManager.startHeartbeat).toHaveBeenCalledWith(
        'lease-abc',
        'user-123',
        'test-org/test-repo#42',
        expect.any(String),
      );

      // Handler was called (dispatch proceeded)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: sampleItem.owner,
          repo: sampleItem.repo,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      // Worker completed successfully
      expect(queue.complete).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ owner: sampleItem.owner }),
      );

      // Lease was released after worker finished
      expect(leaseManager.releaseLease).toHaveBeenCalledWith('lease-abc');

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('dispatch blocked and re-enqueued on lease_denied', () => {
    it('should release item and pause polling when lease is denied', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      (leaseManager.requestLease as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ status: 'denied', reason: 'tier limit reached' });

      dispatcher.setLeaseManager(leaseManager);

      const startPromise = dispatcher.start();
      await tick();

      // Item was released back to queue
      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: sampleItem.owner,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      // Handler should NOT have been called
      expect(handler).not.toHaveBeenCalled();

      // Heartbeat should NOT have been started
      expect(leaseManager.startHeartbeat).not.toHaveBeenCalled();

      // Polling paused — subsequent poll cycles should not claim
      const claimCountAfterDenial = (queue.claim as ReturnType<typeof vi.fn>).mock.calls.length;
      await tick();
      // No new claims should have happened (polling is paused)
      expect((queue.claim as ReturnType<typeof vi.fn>).mock.calls.length).toBe(claimCountAfterDenial);

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('worker cap respects userTierLimit', () => {
    it('should skip claim when userTierLimit is 0', async () => {
      leaseManager = createMockLeaseManager({ userTierLimit: 0 });
      dispatcher.setLeaseManager(leaseManager);

      const startPromise = dispatcher.start();
      await tick();

      // With userTierLimit=0, maxWorkers = min(1, 0) = 0.
      // Since activeWorkers.size (0) >= maxWorkers (0), claim is skipped.
      expect(queue.claim).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          active: 0,
          max: 0,
        }),
        'At worker cap, skipping claim',
      );

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('heartbeat expiry cancels worker and re-enqueues with resume priority (0)', () => {
    it('should cancel worker and re-enqueue when lease:expired is emitted', async () => {
      // Handler that never resolves so the worker stays active
      let resolveHandler!: () => void;
      handler.mockImplementation(
        () => new Promise<void>((resolve) => { resolveHandler = resolve; }),
      );

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      (leaseManager.requestLease as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ status: 'granted', leaseId: 'lease-expire-test' });

      // No duplicates in queue
      (queue.getQueueItems as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      dispatcher.setLeaseManager(leaseManager);

      const startPromise = dispatcher.start();
      await tick();

      // Worker should be active
      expect(dispatcher.getActiveWorkerCount()).toBe(1);

      // Capture the workerId used in startHeartbeat call
      const startHeartbeatCall = (leaseManager.startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0];
      const workerId = startHeartbeatCall[3]; // 4th arg is workerId

      // Emit lease:expired from the lease manager
      leaseManager.emit('lease:expired', {
        leaseId: 'lease-expire-test',
        queueItemId: 'test-org/test-repo#42',
        workerId,
      });

      await tick();

      // Worker should have been removed
      expect(dispatcher.getActiveWorkerCount()).toBe(0);

      // Item should be re-enqueued with priority 0 (resume priority)
      expect(queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: sampleItem.owner,
          repo: sampleItem.repo,
          issueNumber: sampleItem.issueNumber,
          priority: 0,
          queueReason: 'resume',
        }),
      );

      // Log message about lease expiry
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          leaseId: 'lease-expire-test',
        }),
        'Lease expired, cancelling worker and re-enqueuing with resume priority',
      );

      // Resolve the handler to prevent dangling promise
      resolveHandler();

      await dispatcher.stop();
      await startPromise;
    });

    it('should skip re-enqueue when duplicate already exists in queue', async () => {
      let resolveHandler!: () => void;
      handler.mockImplementation(
        () => new Promise<void>((resolve) => { resolveHandler = resolve; }),
      );

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      (leaseManager.requestLease as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ status: 'granted', leaseId: 'lease-dup-test' });

      // Simulate a duplicate already in queue
      (queue.getQueueItems as ReturnType<typeof vi.fn>).mockResolvedValue([
        { item: { ...sampleItem }, score: 1000 },
      ]);

      dispatcher.setLeaseManager(leaseManager);

      const startPromise = dispatcher.start();
      await tick();

      const startHeartbeatCall = (leaseManager.startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0];
      const workerId = startHeartbeatCall[3];

      leaseManager.emit('lease:expired', {
        leaseId: 'lease-dup-test',
        queueItemId: 'test-org/test-repo#42',
        workerId,
      });

      await tick();

      // Should NOT re-enqueue (duplicate detected)
      expect(queue.enqueue).not.toHaveBeenCalled();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'test-org/test-repo#42' }),
        'Skipped re-enqueue (duplicate already in queue)',
      );

      resolveHandler();

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('slot:available triggers pollOnce()', () => {
    it('should resume polling after slot:available is emitted following a denial', async () => {
      // First claim returns item (which will be denied), then after resume another item
      let claimCallCount = 0;
      (queue.claim as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        claimCallCount++;
        if (claimCallCount === 1) return { ...sampleItem };
        if (claimCallCount === 2) return { ...sampleItem, issueNumber: 99 };
        return null;
      });

      // First request denied, second granted
      (leaseManager.requestLease as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ status: 'denied', reason: 'tier limit reached' })
        .mockResolvedValue({ status: 'granted', leaseId: 'lease-after-slot' });

      dispatcher.setLeaseManager(leaseManager);

      const startPromise = dispatcher.start();
      await tick();

      // First claim should have happened and been denied
      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ issueNumber: 42 }),
      );

      // Handler should not have run yet
      expect(handler).not.toHaveBeenCalled();

      // Verify polling is paused — claim count should stay at 1
      const claimCountBeforeSlot = claimCallCount;
      await tick();
      expect(claimCallCount).toBe(claimCountBeforeSlot);

      // Emit slot:available to resume polling
      leaseManager.emit('slot:available', { userId: 'user-123' });
      await tick();

      // Polling should have resumed — a new claim should have happened
      expect(claimCallCount).toBeGreaterThan(claimCountBeforeSlot);

      // Handler should have been called with the new item
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 99 }),
      );

      expect(logger.info).toHaveBeenCalledWith('Slot available, resuming polling');

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('graceful fallback when lease manager not set', () => {
    it('should dispatch normally without lease gating', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Do NOT call setLeaseManager — dispatcher should work without it

      const startPromise = dispatcher.start();
      await tick();

      // Queue was claimed
      expect(queue.claim).toHaveBeenCalled();

      // Handler ran directly without any lease request
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: sampleItem.owner,
          repo: sampleItem.repo,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      // Worker completed successfully
      expect(queue.complete).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ owner: sampleItem.owner }),
      );

      await dispatcher.stop();
      await startPromise;
    });

    it('should not call any lease methods when lease manager is absent', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      const startPromise = dispatcher.start();
      await tick();

      // None of the lease methods should have been touched
      expect(leaseManager.requestLease).not.toHaveBeenCalled();
      expect(leaseManager.startHeartbeat).not.toHaveBeenCalled();
      expect(leaseManager.releaseLease).not.toHaveBeenCalled();

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('lease timeout re-enqueues item', () => {
    it('should release item back to queue on lease timeout', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      (leaseManager.requestLease as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ status: 'timeout' });

      dispatcher.setLeaseManager(leaseManager);

      const startPromise = dispatcher.start();
      await tick();

      // Item was released back to queue
      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: sampleItem.owner,
          issueNumber: sampleItem.issueNumber,
        }),
      );

      // Handler should NOT have been called
      expect(handler).not.toHaveBeenCalled();

      // Heartbeat should NOT have been started
      expect(leaseManager.startHeartbeat).not.toHaveBeenCalled();

      // Polling should NOT be paused (timeout doesn't pause, only denied does)
      // Verify by checking that subsequent claims are attempted
      await tick();
      expect((queue.claim as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('lease release on worker completion', () => {
    it('should release lease when worker handler fails', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      (leaseManager.requestLease as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ status: 'granted', leaseId: 'lease-fail-test' });

      handler.mockRejectedValue(new Error('handler failed'));

      dispatcher.setLeaseManager(leaseManager);

      const startPromise = dispatcher.start();
      await tick();

      // Lease should be released even on failure (finally block)
      expect(leaseManager.releaseLease).toHaveBeenCalledWith('lease-fail-test');

      // Item should be released back to queue
      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ owner: sampleItem.owner }),
      );

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('cluster rejected skips polling', () => {
    it('should skip claim when cluster is rejected', async () => {
      leaseManager = createMockLeaseManager({ isClusterRejected: true });
      dispatcher.setLeaseManager(leaseManager);

      const startPromise = dispatcher.start();
      await tick();

      // Claim should never be called
      expect(queue.claim).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();

      expect(logger.debug).toHaveBeenCalledWith('Cluster rejected, skipping poll');

      await dispatcher.stop();
      await startPromise;
    });
  });
});
