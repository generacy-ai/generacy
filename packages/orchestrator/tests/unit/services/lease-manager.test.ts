import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LeaseManager } from '../../../src/services/lease-manager.js';
import type { ClusterRelayClient, RelayMessage } from '../../../src/types/relay.js';
import type { LeaseConfig } from '../../../src/types/lease.js';

function createMockClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isConnected: true,
  } as unknown as ClusterRelayClient;
}

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const testConfig: LeaseConfig = {
  requestTimeoutMs: 100,
  heartbeatIntervalMs: 50,
  maxHeartbeatFailures: 3,
};

describe('LeaseManager', () => {
  let mockClient: ClusterRelayClient;
  let logger: ReturnType<typeof createMockLogger>;
  let manager: LeaseManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockClient = createMockClient();
    logger = createMockLogger();
    manager = new LeaseManager(mockClient, logger, testConfig);
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // 1. Lease request -> granted flow (correlation ID matching)
  // ---------------------------------------------------------------------------
  describe('requestLease → granted', () => {
    it('resolves with granted status and leaseId when cloud responds', async () => {
      const resultPromise = manager.requestLease('user-1', 'qi-1', 'job-1');

      // Extract the correlationId from the sent message
      expect(mockClient.send).toHaveBeenCalledOnce();
      const sentMsg = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as RelayMessage & {
        correlationId: string;
      };
      expect(sentMsg.type).toBe('lease_request');
      expect(sentMsg.correlationId).toBeDefined();

      // Simulate cloud granting the lease
      manager.handleLeaseResponse({
        type: 'lease_granted',
        correlationId: sentMsg.correlationId,
        leaseId: 'lease-abc',
      });

      const result = await resultPromise;
      expect(result).toEqual({ status: 'granted', leaseId: 'lease-abc' });
    });

    it('sends the correct userId, queueItemId, and jobId in the request', async () => {
      const _promise = manager.requestLease('user-42', 'qi-99', 'job-7');

      const sentMsg = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sentMsg.userId).toBe('user-42');
      expect(sentMsg.queueItemId).toBe('qi-99');
      expect(sentMsg.jobId).toBe('job-7');

      // Clean up: resolve the pending request
      manager.handleLeaseResponse({
        type: 'lease_granted',
        correlationId: sentMsg.correlationId,
        leaseId: 'lease-cleanup',
      });
      await _promise;
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Lease request -> denied flow (re-enqueue signal)
  // ---------------------------------------------------------------------------
  describe('requestLease → denied', () => {
    it('resolves with denied status and reason', async () => {
      const resultPromise = manager.requestLease('user-1', 'qi-1', 'job-1');

      const sentMsg = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as RelayMessage & {
        correlationId: string;
      };

      manager.handleLeaseResponse({
        type: 'lease_denied',
        correlationId: sentMsg.correlationId,
        reason: 'at_capacity',
      });

      const result = await resultPromise;
      expect(result).toEqual({ status: 'denied', reason: 'at_capacity' });
    });

    it('logs the denial with reason and correlationId', async () => {
      const resultPromise = manager.requestLease('user-1', 'qi-1', 'job-1');

      const sentMsg = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];

      manager.handleLeaseResponse({
        type: 'lease_denied',
        correlationId: sentMsg.correlationId,
        reason: 'at_capacity',
      });

      await resultPromise;
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'at_capacity', correlationId: sentMsg.correlationId }),
        'Lease denied',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Lease request -> timeout
  // ---------------------------------------------------------------------------
  describe('requestLease → timeout', () => {
    it('resolves with timeout status after requestTimeoutMs', async () => {
      const resultPromise = manager.requestLease('user-1', 'qi-1', 'job-1');

      // Advance past the timeout
      vi.advanceTimersByTime(testConfig.requestTimeoutMs);

      const result = await resultPromise;
      expect(result).toEqual({ status: 'timeout' });
    });

    it('logs a warning on timeout', async () => {
      const resultPromise = manager.requestLease('user-1', 'qi-1', 'job-1');

      vi.advanceTimersByTime(testConfig.requestTimeoutMs);

      await resultPromise;
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ queueItemId: 'qi-1' }),
        'Lease request timed out',
      );
    });

    it('returns timeout when client.send throws', async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('connection lost');
      });

      const result = await manager.requestLease('user-1', 'qi-1', 'job-1');
      expect(result).toEqual({ status: 'timeout' });
    });

    it('ignores late responses after timeout', async () => {
      const resultPromise = manager.requestLease('user-1', 'qi-1', 'job-1');
      const sentMsg = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Timeout fires first
      vi.advanceTimersByTime(testConfig.requestTimeoutMs);
      const result = await resultPromise;
      expect(result).toEqual({ status: 'timeout' });

      // Late response — should be ignored and logged as unknown
      manager.handleLeaseResponse({
        type: 'lease_granted',
        correlationId: sentMsg.correlationId,
        leaseId: 'lease-late',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: sentMsg.correlationId }),
        'Received lease response for unknown correlation ID',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Heartbeat loop sends every heartbeatIntervalMs
  // ---------------------------------------------------------------------------
  describe('heartbeat loop', () => {
    it('sends lease_heartbeat at each interval', () => {
      manager.startHeartbeat('lease-1', 'user-1', 'qi-1', 'worker-1');

      // Clear the send mock (requestLease sends are not relevant here)
      (mockClient.send as ReturnType<typeof vi.fn>).mockClear();

      // Advance through 3 heartbeat intervals
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs);
      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect((mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
        type: 'lease_heartbeat',
        leaseId: 'lease-1',
      });

      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs);
      expect(mockClient.send).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs);
      expect(mockClient.send).toHaveBeenCalledTimes(3);
    });

    it('tracks the lease in activeLeaseCount', () => {
      expect(manager.activeLeaseCount).toBe(0);
      manager.startHeartbeat('lease-1', 'user-1', 'qi-1', 'worker-1');
      expect(manager.activeLeaseCount).toBe(1);
      manager.startHeartbeat('lease-2', 'user-1', 'qi-2', 'worker-2');
      expect(manager.activeLeaseCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. 3 consecutive heartbeat failures -> lease:expired event
  // ---------------------------------------------------------------------------
  describe('heartbeat failure → lease expiry', () => {
    it('emits lease:expired after maxHeartbeatFailures consecutive failures', () => {
      manager.startHeartbeat('lease-1', 'user-1', 'qi-1', 'worker-1');

      // Make send throw only for heartbeat messages
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation((msg: RelayMessage) => {
        if (msg.type === 'lease_heartbeat') {
          throw new Error('send failed');
        }
      });

      const expiredHandler = vi.fn();
      manager.on('lease:expired', expiredHandler);

      // Advance through 3 heartbeat intervals (maxHeartbeatFailures = 3)
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs); // failure 1
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs); // failure 2
      expect(expiredHandler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs); // failure 3 → expired
      expect(expiredHandler).toHaveBeenCalledOnce();
      expect(expiredHandler).toHaveBeenCalledWith({
        leaseId: 'lease-1',
        queueItemId: 'qi-1',
        workerId: 'worker-1',
      });
    });

    it('removes the lease from active leases after expiry', () => {
      manager.startHeartbeat('lease-1', 'user-1', 'qi-1', 'worker-1');
      expect(manager.activeLeaseCount).toBe(1);

      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation((msg: RelayMessage) => {
        if (msg.type === 'lease_heartbeat') {
          throw new Error('send failed');
        }
      });

      // Advance through 3 failures
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs * testConfig.maxHeartbeatFailures);

      expect(manager.activeLeaseCount).toBe(0);
    });

    it('stops the heartbeat interval after expiry', () => {
      manager.startHeartbeat('lease-1', 'user-1', 'qi-1', 'worker-1');

      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation((msg: RelayMessage) => {
        if (msg.type === 'lease_heartbeat') {
          throw new Error('send failed');
        }
      });

      // Expire the lease
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs * testConfig.maxHeartbeatFailures);
      (mockClient.send as ReturnType<typeof vi.fn>).mockClear();

      // Further ticks should not attempt sends
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs * 3);
      expect(mockClient.send).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Single heartbeat failure -> no expiry (tolerance)
  // ---------------------------------------------------------------------------
  describe('heartbeat failure tolerance', () => {
    it('does not expire after a single failure', () => {
      manager.startHeartbeat('lease-1', 'user-1', 'qi-1', 'worker-1');

      const expiredHandler = vi.fn();
      manager.on('lease:expired', expiredHandler);

      // Fail once
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation((msg: RelayMessage) => {
        if (msg.type === 'lease_heartbeat') {
          throw new Error('send failed');
        }
      });
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs); // failure 1

      expect(expiredHandler).not.toHaveBeenCalled();
      expect(manager.activeLeaseCount).toBe(1);
    });

    it('resets failure count on successful heartbeat', () => {
      manager.startHeartbeat('lease-1', 'user-1', 'qi-1', 'worker-1');

      const expiredHandler = vi.fn();
      manager.on('lease:expired', expiredHandler);

      // Fail twice
      let shouldFail = true;
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation((msg: RelayMessage) => {
        if (msg.type === 'lease_heartbeat' && shouldFail) {
          throw new Error('send failed');
        }
      });

      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs); // failure 1
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs); // failure 2

      // Succeed on next heartbeat — resets counter
      shouldFail = false;
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs); // success → counter = 0

      // Fail twice more — should NOT expire because counter was reset
      shouldFail = true;
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs); // failure 1
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs); // failure 2

      expect(expiredHandler).not.toHaveBeenCalled();
      expect(manager.activeLeaseCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Lease release stops heartbeat and sends message
  // ---------------------------------------------------------------------------
  describe('releaseLease', () => {
    it('sends lease_release message and stops heartbeat', () => {
      manager.startHeartbeat('lease-1', 'user-1', 'qi-1', 'worker-1');
      expect(manager.activeLeaseCount).toBe(1);

      (mockClient.send as ReturnType<typeof vi.fn>).mockClear();
      manager.releaseLease('lease-1');

      // Should have sent lease_release
      expect(mockClient.send).toHaveBeenCalledWith({
        type: 'lease_release',
        leaseId: 'lease-1',
      });

      // Should remove from active leases
      expect(manager.activeLeaseCount).toBe(0);

      // No more heartbeats should be sent
      (mockClient.send as ReturnType<typeof vi.fn>).mockClear();
      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs * 3);
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it('handles releasing a non-existent lease gracefully', () => {
      // Should not throw
      manager.releaseLease('non-existent-lease');
      expect(mockClient.send).toHaveBeenCalledWith({
        type: 'lease_release',
        leaseId: 'non-existent-lease',
      });
    });

    it('logs warning when send fails during release (non-fatal)', () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('disconnected');
      });

      manager.releaseLease('lease-1');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ leaseId: 'lease-1' }),
        'Failed to send lease_release (non-fatal)',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 8. slot_available emits slot:available event
  // ---------------------------------------------------------------------------
  describe('handleSlotAvailable', () => {
    it('emits slot:available with userId', () => {
      const handler = vi.fn();
      manager.on('slot:available', handler);

      manager.handleSlotAvailable({
        type: 'slot_available',
        orgId: 'org-1',
        userId: 'user-1',
        timestamp: '2026-04-05T00:00:00Z',
        availableSlots: 2,
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ userId: 'user-1' });
    });

    it('logs the slot availability', () => {
      manager.handleSlotAvailable({
        type: 'slot_available',
        orgId: 'org-1',
        userId: 'user-1',
        timestamp: '2026-04-05T00:00:00Z',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
        'Slot available',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 9. tier_info sets userTierLimit
  // ---------------------------------------------------------------------------
  describe('handleTierInfo', () => {
    it('sets userTierLimit from maxConcurrentWorkflows', () => {
      expect(manager.userTierLimit).toBeNull();

      manager.handleTierInfo({
        type: 'tier_info',
        tier: 'professional',
        maxConcurrentWorkflows: 10,
        maxActiveClusters: 3,
      });

      expect(manager.userTierLimit).toBe(10);
    });

    it('updates userTierLimit on subsequent tier_info messages', () => {
      manager.handleTierInfo({
        type: 'tier_info',
        tier: 'free',
        maxConcurrentWorkflows: 1,
        maxActiveClusters: 1,
      });
      expect(manager.userTierLimit).toBe(1);

      manager.handleTierInfo({
        type: 'tier_info',
        tier: 'enterprise',
        maxConcurrentWorkflows: 50,
        maxActiveClusters: 10,
      });
      expect(manager.userTierLimit).toBe(50);
    });

    it('logs tier info', () => {
      manager.handleTierInfo({
        type: 'tier_info',
        tier: 'standard',
        maxConcurrentWorkflows: 5,
        maxActiveClusters: 2,
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ tier: 'standard', maxConcurrentWorkflows: 5 }),
        'Tier info received',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 10. cluster_rejected sets flag and emits event
  // ---------------------------------------------------------------------------
  describe('handleClusterRejected', () => {
    it('sets isClusterRejected flag to true', () => {
      expect(manager.isClusterRejected).toBe(false);

      manager.handleClusterRejected({
        type: 'cluster_rejected',
        reason: 'Too many active clusters',
        tier: 'free',
        maxActiveClusters: 1,
        currentActiveClusters: 1,
      });

      expect(manager.isClusterRejected).toBe(true);
    });

    it('emits cluster:rejected event with reason and tier', () => {
      const handler = vi.fn();
      manager.on('cluster:rejected', handler);

      manager.handleClusterRejected({
        type: 'cluster_rejected',
        reason: 'Too many active clusters',
        tier: 'free',
        maxActiveClusters: 1,
        currentActiveClusters: 1,
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({
        reason: 'Too many active clusters',
        tier: 'free',
      });
    });

    it('logs the rejection with full details', () => {
      manager.handleClusterRejected({
        type: 'cluster_rejected',
        reason: 'Cluster limit exceeded',
        tier: 'basic',
        maxActiveClusters: 2,
        currentActiveClusters: 2,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'Cluster limit exceeded',
          tier: 'basic',
          maxActiveClusters: 2,
          currentActiveClusters: 2,
        }),
        'Cluster rejected by cloud',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 11. Shutdown properly cleans up
  // ---------------------------------------------------------------------------
  describe('shutdown', () => {
    it('releases all active leases', async () => {
      manager.startHeartbeat('lease-1', 'user-1', 'qi-1', 'worker-1');
      manager.startHeartbeat('lease-2', 'user-1', 'qi-2', 'worker-2');
      expect(manager.activeLeaseCount).toBe(2);

      await manager.shutdown();

      expect(manager.activeLeaseCount).toBe(0);
      // Should have sent lease_release for each
      const releaseCalls = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0].type === 'lease_release',
      );
      expect(releaseCalls).toHaveLength(2);
    });

    it('resolves pending requests with timeout status', async () => {
      const resultPromise = manager.requestLease('user-1', 'qi-1', 'job-1');

      await manager.shutdown();

      const result = await resultPromise;
      expect(result).toEqual({ status: 'timeout' });
    });

    it('stops heartbeat intervals so no further sends occur', async () => {
      manager.startHeartbeat('lease-1', 'user-1', 'qi-1', 'worker-1');

      await manager.shutdown();
      (mockClient.send as ReturnType<typeof vi.fn>).mockClear();

      vi.advanceTimersByTime(testConfig.heartbeatIntervalMs * 5);
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it('removes all event listeners', async () => {
      const handler = vi.fn();
      manager.on('lease:expired', handler);
      manager.on('slot:available', handler);

      await manager.shutdown();

      expect(manager.listenerCount('lease:expired')).toBe(0);
      expect(manager.listenerCount('slot:available')).toBe(0);
    });

    it('handles shutdown when there are no active leases or pending requests', async () => {
      // Should not throw
      await manager.shutdown();
      expect(manager.activeLeaseCount).toBe(0);
    });
  });
});
