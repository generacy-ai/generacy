import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerDispatcher } from '../../../src/services/worker-dispatcher.js';
import { LeaseManager } from '../../../src/services/lease-manager.js';
import type { QueueManager, QueueItem, WorkerHandler } from '../../../src/types/index.js';
import type { DispatchConfig } from '../../../src/config/index.js';
import type { ClusterRelayClient } from '../../../src/types/relay.js';
import type { LeaseConfig } from '../../../src/types/lease.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function createMockRelayClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isConnected: true,
  } as unknown as ClusterRelayClient;
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

const testConfig: DispatchConfig = {
  pollIntervalMs: 10,
  heartbeatTtlMs: 200,
  heartbeatCheckIntervalMs: 20,
  shutdownTimeoutMs: 100,
  maxRetries: 3,
};

const testLeaseConfig: LeaseConfig = {
  requestTimeoutMs: 5000,
  heartbeatIntervalMs: 100,
  maxHeartbeatFailures: 3,
};

/** Wait for a short period to let poll/reaper ticks happen */
function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the correlationId from the mock relay client's send calls.
 * Looks for a lease_request message and returns its correlationId.
 */
function extractCorrelationId(mockClient: ClusterRelayClient): string {
  const sendMock = mockClient.send as ReturnType<typeof vi.fn>;
  const leaseRequestCall = sendMock.mock.calls.find(
    (call: unknown[]) => (call[0] as { type: string }).type === 'lease_request',
  );
  if (!leaseRequestCall) {
    throw new Error('No lease_request send call found');
  }
  return (leaseRequestCall[0] as { correlationId: string }).correlationId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerDispatcher lease integration', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let queue: QueueManager;
  let handler: ReturnType<typeof vi.fn<WorkerHandler>>;
  let dispatcher: WorkerDispatcher;
  let relayClient: ClusterRelayClient;
  let leaseManager: LeaseManager;

  beforeEach(() => {
    logger = createMockLogger();
    queue = createMockQueueManager();
    handler = vi.fn<WorkerHandler>().mockResolvedValue(undefined);
    relayClient = createMockRelayClient();
    leaseManager = new LeaseManager(relayClient, logger, testLeaseConfig);

    // Use null Redis so heartbeats are in-memory (simpler for lease tests)
    dispatcher = new WorkerDispatcher(queue, null, logger, testConfig, handler);
  });

  afterEach(async () => {
    if (dispatcher.isRunning()) {
      await dispatcher.stop();
    }
    await leaseManager.shutdown();
  });

  // -------------------------------------------------------------------------
  // 1. Dispatch is gated on lease_granted
  // -------------------------------------------------------------------------
  describe('dispatch gated on lease_granted', () => {
    it('should call requestLease before dispatching when lease manager is set and userTierLimit is set', async () => {
      // Set tier limit so lease gating activates
      leaseManager.handleTierInfo({
        type: 'tier_info',
        tier: 'basic',
        maxConcurrentWorkflows: 2,
        maxActiveClusters: 1,
      });

      dispatcher.setLeaseManager(leaseManager);

      // Queue returns one item, then nothing
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Start pollOnce — it will send lease_request and wait for response
      const pollPromise = (dispatcher as any).pollOnce();

      // Give microtasks a chance to process
      await tick(20);

      // Verify lease_request was sent
      const sendMock = relayClient.send as ReturnType<typeof vi.fn>;
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'lease_request',
          userId: 'user-123',
          queueItemId: 'test-org/test-repo#42',
        }),
      );

      // Handler should NOT have been called yet (waiting for lease response)
      expect(handler).not.toHaveBeenCalled();

      // Simulate lease_granted response
      const correlationId = extractCorrelationId(relayClient);
      leaseManager.handleLeaseResponse({
        type: 'lease_granted',
        correlationId,
        leaseId: 'lease-abc',
      });

      await pollPromise;

      // Now wait for handler to run
      await tick(20);

      // Handler should have been called after grant
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Dispatch blocked and re-enqueued on lease_denied
  // -------------------------------------------------------------------------
  describe('dispatch blocked on lease_denied', () => {
    it('should release item back to queue and pause polling when lease is denied', async () => {
      leaseManager.handleTierInfo({
        type: 'tier_info',
        tier: 'free',
        maxConcurrentWorkflows: 1,
        maxActiveClusters: 1,
      });

      dispatcher.setLeaseManager(leaseManager);

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Start pollOnce
      const pollPromise = (dispatcher as any).pollOnce();

      await tick(20);

      // Simulate lease_denied
      const correlationId = extractCorrelationId(relayClient);
      leaseManager.handleLeaseResponse({
        type: 'lease_denied',
        correlationId,
        reason: 'at_capacity',
      });

      await pollPromise;

      // Item should be released back to queue
      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
        }),
      );

      // Handler should NOT have been called
      expect(handler).not.toHaveBeenCalled();

      // Polling should now be paused — calling pollOnce again should be a no-op
      (queue.claim as ReturnType<typeof vi.fn>).mockClear();
      await (dispatcher as any).pollOnce();
      expect(queue.claim).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Worker cap respects userTierLimit
  // -------------------------------------------------------------------------
  describe('worker cap respects userTierLimit', () => {
    it('should not start workers when userTierLimit is 0', async () => {
      leaseManager.handleTierInfo({
        type: 'tier_info',
        tier: 'free',
        maxConcurrentWorkflows: 0,
        maxActiveClusters: 1,
      });

      dispatcher.setLeaseManager(leaseManager);

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ ...sampleItem });

      // pollOnce should return early due to maxWorkers = 0
      await (dispatcher as any).pollOnce();

      // claim should never be called since maxWorkers = min(1, 0) = 0
      expect(queue.claim).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();

      // Logger should report at worker cap
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ active: 0, max: 0 }),
        'At worker cap, skipping claim',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. Heartbeat expiry cancels worker and re-enqueues with resume priority
  // -------------------------------------------------------------------------
  describe('heartbeat expiry cancels worker and re-enqueues', () => {
    it('should cancel worker and re-enqueue with priority 0 when lease heartbeat expires', async () => {
      leaseManager.handleTierInfo({
        type: 'tier_info',
        tier: 'basic',
        maxConcurrentWorkflows: 2,
        maxActiveClusters: 1,
      });

      dispatcher.setLeaseManager(leaseManager);

      // Handler that never resolves (long-running worker)
      handler.mockImplementation(() => new Promise<void>(() => {}));

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Start pollOnce
      const pollPromise = (dispatcher as any).pollOnce();

      await tick(20);

      // Simulate lease_granted
      const correlationId = extractCorrelationId(relayClient);
      leaseManager.handleLeaseResponse({
        type: 'lease_granted',
        correlationId,
        leaseId: 'lease-expire-test',
      });

      await pollPromise;
      await tick(20);

      // Worker should be active
      expect(dispatcher.getActiveWorkerCount()).toBe(1);

      // Make the relay client's send throw to simulate heartbeat failures
      const sendMock = relayClient.send as ReturnType<typeof vi.fn>;
      sendMock.mockImplementation(() => {
        throw new Error('Connection lost');
      });

      // Wait for enough heartbeat intervals to exceed maxHeartbeatFailures (3)
      // Heartbeat interval is 100ms, so 3 failures = ~300ms + some buffer
      await tick(450);

      // lease:expired should have been emitted and handled —
      // worker should be removed and item re-enqueued
      expect(dispatcher.getActiveWorkerCount()).toBe(0);

      expect(queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
          priority: 0,
          queueReason: 'resume',
        }),
      );
    });

    it('should not re-enqueue if duplicate already in queue', async () => {
      leaseManager.handleTierInfo({
        type: 'tier_info',
        tier: 'basic',
        maxConcurrentWorkflows: 2,
        maxActiveClusters: 1,
      });

      dispatcher.setLeaseManager(leaseManager);

      handler.mockImplementation(() => new Promise<void>(() => {}));

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Simulate duplicate already in queue
      (queue.getQueueItems as ReturnType<typeof vi.fn>).mockResolvedValue([
        { item: { ...sampleItem }, score: 1000 },
      ]);

      const pollPromise = (dispatcher as any).pollOnce();
      await tick(20);

      const correlationId = extractCorrelationId(relayClient);
      leaseManager.handleLeaseResponse({
        type: 'lease_granted',
        correlationId,
        leaseId: 'lease-dup-test',
      });

      await pollPromise;
      await tick(20);

      // Make heartbeats fail
      (relayClient.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Connection lost');
      });

      await tick(450);

      // Worker removed but enqueue should NOT be called (duplicate exists)
      expect(dispatcher.getActiveWorkerCount()).toBe(0);
      expect(queue.enqueue).not.toHaveBeenCalled();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'test-org/test-repo#42' }),
        'Skipped re-enqueue (duplicate already in queue)',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. slot_available triggers pollOnce()
  // -------------------------------------------------------------------------
  describe('slot_available triggers pollOnce', () => {
    it('should resume polling when slot_available is received after lease_denied pause', async () => {
      leaseManager.handleTierInfo({
        type: 'tier_info',
        tier: 'free',
        maxConcurrentWorkflows: 1,
        maxActiveClusters: 1,
      });

      dispatcher.setLeaseManager(leaseManager);

      // First poll: item claimed, lease denied
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      const pollPromise = (dispatcher as any).pollOnce();
      await tick(20);

      // Deny the lease to trigger pause
      const correlationId = extractCorrelationId(relayClient);
      leaseManager.handleLeaseResponse({
        type: 'lease_denied',
        correlationId,
        reason: 'at_capacity',
      });

      await pollPromise;

      // Confirm polling is paused
      (queue.claim as ReturnType<typeof vi.fn>).mockClear();
      await (dispatcher as any).pollOnce();
      expect(queue.claim).not.toHaveBeenCalled();

      // Now set up the next poll to succeed (no item to claim)
      (queue.claim as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      // Emit slot_available — this should unpause and trigger pollOnce
      leaseManager.handleSlotAvailable({
        type: 'slot_available',
        orgId: 'org-1',
        userId: 'user-123',
        timestamp: new Date().toISOString(),
      });

      await tick(20);

      // Polling should have resumed — claim should have been called
      expect(queue.claim).toHaveBeenCalled();

      expect(logger.info).toHaveBeenCalledWith('Slot available, resuming polling');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Graceful fallback when lease manager not set
  // -------------------------------------------------------------------------
  describe('graceful fallback without lease manager', () => {
    it('should dispatch normally when no lease manager is set', async () => {
      // Do NOT call setLeaseManager — dispatcher has no lease gating

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      handler.mockResolvedValue(undefined);

      await (dispatcher as any).pollOnce();

      // Wait for handler to complete
      await tick(20);

      // Handler should be called directly without any lease request
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
        }),
      );

      // No lease_request should have been sent
      expect(relayClient.send).not.toHaveBeenCalled();
    });

    it('should dispatch normally when lease manager is set but userTierLimit is null', async () => {
      // Set lease manager but do NOT call handleTierInfo — userTierLimit stays null
      dispatcher.setLeaseManager(leaseManager);

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      handler.mockResolvedValue(undefined);

      await (dispatcher as any).pollOnce();
      await tick(20);

      // Handler should be called without lease gating
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
        }),
      );

      // No lease_request should have been sent (tier limit not yet known)
      const sendMock = relayClient.send as ReturnType<typeof vi.fn>;
      const leaseRequests = sendMock.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'lease_request',
      );
      expect(leaseRequests).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Lease release on worker completion
  // -------------------------------------------------------------------------
  describe('lease release on worker completion', () => {
    it('should release lease when worker completes successfully', async () => {
      leaseManager.handleTierInfo({
        type: 'tier_info',
        tier: 'basic',
        maxConcurrentWorkflows: 2,
        maxActiveClusters: 1,
      });

      dispatcher.setLeaseManager(leaseManager);

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      handler.mockResolvedValue(undefined);

      const pollPromise = (dispatcher as any).pollOnce();
      await tick(20);

      // Grant the lease
      const correlationId = extractCorrelationId(relayClient);
      leaseManager.handleLeaseResponse({
        type: 'lease_granted',
        correlationId,
        leaseId: 'lease-release-test',
      });

      await pollPromise;

      // Wait for handler to finish
      await tick(50);

      // Lease should be released (lease_release sent)
      const sendMock = relayClient.send as ReturnType<typeof vi.fn>;
      const releaseMessages = sendMock.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'lease_release',
      );
      expect(releaseMessages).toHaveLength(1);
      expect(releaseMessages[0][0]).toEqual(
        expect.objectContaining({
          type: 'lease_release',
          leaseId: 'lease-release-test',
        }),
      );

      // Worker should be cleaned up
      expect(dispatcher.getActiveWorkerCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Lease request timeout
  // -------------------------------------------------------------------------
  describe('lease request timeout', () => {
    it('should release item back to queue on lease request timeout', async () => {
      // Use a very short timeout for this test
      const shortTimeoutLeaseConfig: LeaseConfig = {
        requestTimeoutMs: 50,
        heartbeatIntervalMs: 100,
        maxHeartbeatFailures: 3,
      };

      const shortTimeoutLeaseManager = new LeaseManager(
        relayClient,
        logger,
        shortTimeoutLeaseConfig,
      );

      shortTimeoutLeaseManager.handleTierInfo({
        type: 'tier_info',
        tier: 'basic',
        maxConcurrentWorkflows: 2,
        maxActiveClusters: 1,
      });

      dispatcher.setLeaseManager(shortTimeoutLeaseManager);

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Do NOT respond to the lease request — let it time out
      await (dispatcher as any).pollOnce();

      // Item should be released back to queue
      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
        }),
      );

      // Handler should NOT have been called
      expect(handler).not.toHaveBeenCalled();

      await shortTimeoutLeaseManager.shutdown();
    });
  });
});
