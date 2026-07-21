/**
 * Integration tests for the lease protocol with a mock relay.
 *
 * These tests verify the full lifecycle: enqueue → lease_request → granted →
 * dispatch → complete → release, as well as denied/slot_available recovery
 * and heartbeat failure re-enqueue flows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { LeaseManager } from '../../src/services/lease-manager.js';
import { WorkerDispatcher } from '../../src/services/worker-dispatcher.js';
import type {
  QueueManager,
  QueueItem,
  WorkerHandler,
} from '../../src/types/index.js';
import type { DispatchConfig } from '../../src/config/index.js';
import type { LeaseConfig } from '../../src/types/lease.js';
import type { ClusterRelayClient, RelayMessage } from '../../src/types/relay.js';

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

/**
 * MockRelayClient simulates the cloud relay. Outbound messages are captured
 * in `sentMessages`. Tests can install an `onSend` hook to auto-respond to
 * outbound messages (the hook fires asynchronously so the LeaseManager's
 * pending-request map is populated before the response arrives).
 */
class MockRelayClient extends EventEmitter implements ClusterRelayClient {
  readonly sentMessages: RelayMessage[] = [];
  private _isConnected = true;
  /** Optional hook called (async, next microtask) for every outbound message */
  onSend: ((msg: RelayMessage) => void) | null = null;

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    this._isConnected = false;
  }

  send(message: RelayMessage): void {
    if (!this._isConnected) throw new Error('Not connected');
    this.sentMessages.push(message);
    // Fire the hook asynchronously so the caller can register its pending state first
    if (this.onSend) {
      const hook = this.onSend;
      const msg = message;
      queueMicrotask(() => hook(msg));
    }
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    return super.on(event, handler);
  }

  off(event: string, handler: (...args: unknown[]) => void): this {
    return super.off(event, handler);
  }

  /** Force disconnect to simulate network failure */
  simulateDisconnect(): void {
    this._isConnected = false;
  }
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

const dispatchConfig: DispatchConfig = {
  pollIntervalMs: 10,
  heartbeatTtlMs: 200,
  heartbeatCheckIntervalMs: 20,
  shutdownTimeoutMs: 100,
  maxRetries: 3,
  // Large so the denial backstop never fires unless a test opts into a
  // shorter value explicitly.
  denialResumeMs: 60_000,
};

const leaseConfig: LeaseConfig = {
  requestTimeoutMs: 500,
  heartbeatIntervalMs: 50,
  maxHeartbeatFailures: 3,
};

function tick(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Lease + Relay integration', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let queue: QueueManager;
  let handler: ReturnType<typeof vi.fn<WorkerHandler>>;
  let relay: MockRelayClient;
  let leaseManager: LeaseManager;
  let dispatcher: WorkerDispatcher;

  beforeEach(() => {
    logger = createMockLogger();
    queue = createMockQueueManager();
    handler = vi.fn<WorkerHandler>().mockResolvedValue({ status: 'completed' });
    relay = new MockRelayClient();
    leaseManager = new LeaseManager(relay, logger, leaseConfig);
    dispatcher = new WorkerDispatcher(queue, null, logger, dispatchConfig, handler);

    // Wire up the lease manager. The gate engages as soon as a manager is
    // set — the cloud never sends tier_info (#1016), so no tier bootstrap here.
    dispatcher.setLeaseManager(leaseManager);
  });

  afterEach(async () => {
    if (dispatcher.isRunning()) {
      await dispatcher.stop();
    }
    await leaseManager.shutdown();
  });

  describe('full lifecycle: enqueue → lease_request → granted → dispatch → complete → release', () => {
    it('should complete full lease lifecycle end-to-end', async () => {
      // Set up queue to return one item then empty
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // Auto-respond via the async onSend hook, routing on msg.type the same
      // way the relay bridge does (relay-bridge routes 'lease_response' to
      // leaseManager.handleLeaseResponse).
      relay.onSend = (msg) => {
        if (msg.type === 'lease_request') {
          const request = msg as RelayMessage & { correlationId: string };
          leaseManager.handleLeaseResponse({
            type: 'lease_response',
            status: 'granted',
            correlationId: request.correlationId,
            leaseId: 'integration-lease-1',
            ttlSeconds: 300,
          });
        }
        if (msg.type === 'lease_release') {
          const release = msg as RelayMessage & { correlationId: string };
          // Cloud acks every release with a lease_response {status: 'released'}
          leaseManager.handleLeaseResponse({
            type: 'lease_response',
            status: 'released',
            correlationId: release.correlationId,
          });
        }
      };

      const startPromise = dispatcher.start();
      await tick();

      // 1. lease_request was sent
      const leaseRequest = relay.sentMessages.find((m) => m.type === 'lease_request');
      expect(leaseRequest).toBeDefined();
      expect(leaseRequest).toMatchObject({
        type: 'lease_request',
        userId: 'user-123',
        queueItemId: 'test-org/test-repo#42',
      });

      // 2. Handler was invoked (dispatch proceeded after grant)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
        }),
      );

      // 3. Worker completed
      expect(queue.complete).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ owner: 'test-org' }),
      );

      // 4. lease_release was sent after worker finished — WITH a correlationId
      //    (the cloud refuses releases without one)
      const leaseRelease = relay.sentMessages.find((m) => m.type === 'lease_release');
      expect(leaseRelease).toBeDefined();
      expect(leaseRelease).toMatchObject({
        type: 'lease_release',
        correlationId: expect.any(String),
        leaseId: 'integration-lease-1',
      });

      // 5. The released ack (sent by the onSend hook) was silently consumed —
      //    no "unknown correlation ID" warning
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'Received lease response for unknown correlation ID',
      );

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('denied flow with slot_available recovery', () => {
    it('should pause on denial and resume when slot becomes available', async () => {
      let claimCount = 0;
      (queue.claim as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        claimCount++;
        if (claimCount <= 2) return { ...sampleItem, issueNumber: claimCount };
        return null;
      });

      // Track lease_request count to respond differently
      let leaseRequestCount = 0;

      relay.onSend = (msg) => {
        if (msg.type === 'lease_request') {
          leaseRequestCount++;
          const request = msg as RelayMessage & { correlationId: string };
          if (leaseRequestCount === 1) {
            leaseManager.handleLeaseResponse({
              type: 'lease_response',
              status: 'denied',
              correlationId: request.correlationId,
              reason: 'at_capacity',
              currentCount: 1,
              limit: 1,
            });
          } else {
            leaseManager.handleLeaseResponse({
              type: 'lease_response',
              status: 'granted',
              correlationId: request.correlationId,
              leaseId: `lease-recovery-${leaseRequestCount}`,
            });
          }
        }
      };

      const startPromise = dispatcher.start();
      await tick();

      // First attempt was denied — item released
      expect(queue.release).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ issueNumber: 1 }),
      );

      // Handler should NOT have run yet
      expect(handler).not.toHaveBeenCalled();

      // Tier limit was learned from the denial payload (cloud never sends tier_info)
      expect(leaseManager.userTierLimit).toBe(1);

      // Simulate cloud sending slot_available
      leaseManager.handleSlotAvailable({
        type: 'slot_available',
        orgId: 'org-1',
        userId: 'user-123',
        timestamp: new Date().toISOString(),
      });

      await tick();

      // Polling should have resumed and handler should have run
      expect(handler).toHaveBeenCalled();
      expect(leaseRequestCount).toBe(2);

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('lease-less cloud: request timeout fails open', () => {
    it('should dispatch without a lease when the cloud never answers', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      // No onSend hook — the relay swallows lease_request and never responds,
      // like a cloud without an ExecutionLeaseService.
      relay.onSend = null;

      const startPromise = dispatcher.start();

      // Wait past requestTimeoutMs (500ms) for the fail-open dispatch
      await tick(700);

      // Handler ran even though no lease was ever granted
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
        }),
      );

      // The item completed; it was never released back for the timeout
      expect(queue.complete).toHaveBeenCalled();
      expect(queue.release).not.toHaveBeenCalled();

      // No lease existed, so no lease_release was sent
      expect(relay.sentMessages.find((m) => m.type === 'lease_release')).toBeUndefined();

      // The fail-open dispatch was logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ queueItemId: 'test-org/test-repo#42' }),
        'Lease request timed out — dispatching without lease (fail-open)',
      );

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('heartbeat failure and re-enqueue', () => {
    it('should expire lease and re-enqueue when heartbeats fail', async () => {
      // Handler that blocks
      let resolveHandler!: () => void;
      handler.mockImplementation(
        () => new Promise<{ status: 'completed' }>((resolve) => {
          resolveHandler = () => resolve({ status: 'completed' });
        }),
      );

      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ...sampleItem })
        .mockResolvedValue(null);

      (queue.getQueueItems as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      // Auto-grant lease requests (via async onSend hook)
      relay.onSend = (msg) => {
        if (msg.type === 'lease_request') {
          const request = msg as RelayMessage & { correlationId: string };
          leaseManager.handleLeaseResponse({
            type: 'lease_response',
            status: 'granted',
            correlationId: request.correlationId,
            leaseId: 'lease-heartbeat-fail',
          });
        }
      };

      const startPromise = dispatcher.start();
      await tick();

      // Worker should be active
      expect(dispatcher.getActiveWorkerCount()).toBe(1);

      // Simulate network failure — make send throw for heartbeats
      // Clear the onSend hook so it doesn't interfere
      relay.onSend = null;
      relay.simulateDisconnect();

      // Wait for 3 heartbeat failures (3 * 50ms = 150ms) + buffer
      await tick(250);

      // Worker should have been removed after lease expiry
      expect(dispatcher.getActiveWorkerCount()).toBe(0);

      // Item should be re-enqueued with resume priority
      expect(queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: sampleItem.owner,
          repo: sampleItem.repo,
          issueNumber: sampleItem.issueNumber,
          priority: 0,
          queueReason: 'resume',
        }),
      );

      // Resolve handler to clean up
      resolveHandler();

      await dispatcher.stop();
      await startPromise;
    });
  });

  describe('cluster rejection prevents queue processing', () => {
    it('should stop processing when cluster_rejected is received', async () => {
      (queue.claim as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ ...sampleItem });

      // Simulate cluster_rejected (cloud field names: reason/currentLimit/tierName)
      leaseManager.handleClusterRejected({
        type: 'cluster_rejected',
        reason: 'cluster_limit_reached',
        tierName: 'free',
        currentLimit: 1,
        upgradeHint: 'Upgrade to run more clusters',
      });

      expect(leaseManager.isClusterRejected).toBe(true);

      const startPromise = dispatcher.start();
      await tick();

      // No claims should happen while cluster is rejected
      expect(queue.claim).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();

      await dispatcher.stop();
      await startPromise;
    });
  });
});
