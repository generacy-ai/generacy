/**
 * LeaseManager: Per-user execution lease lifecycle management (#418).
 *
 * Owns the full lease lifecycle: request, heartbeat, release, expiry.
 * Injected into WorkerDispatcher (for dispatch gating) and RelayBridge (for message routing).
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  Lease,
  LeaseRequestResult,
  LeaseConfig,
  ILeaseManager,
  RelayLeaseGranted,
  RelayLeaseDenied,
  RelaySlotAvailable,
  RelayTierInfo,
  RelayClusterRejected,
} from '../types/lease.js';
import type { ClusterRelayClient, RelayMessage } from '../types/relay.js';

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

interface PendingRequest {
  resolve: (result: LeaseRequestResult) => void;
  timer: NodeJS.Timeout;
}

export class LeaseManager extends EventEmitter implements ILeaseManager {
  private readonly client: ClusterRelayClient;
  private readonly logger: Logger;
  private readonly config: LeaseConfig;

  /** Active leases: leaseId → Lease */
  private readonly activeLeases = new Map<string, Lease>();
  /** Pending lease requests: correlationId → PendingRequest */
  private readonly pendingRequests = new Map<string, PendingRequest>();

  private _userTierLimit: number | null = null;
  private _clusterRejected = false;

  constructor(client: ClusterRelayClient, logger: Logger, config: LeaseConfig) {
    super();
    this.client = client;
    this.logger = logger;
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get userTierLimit(): number | null {
    return this._userTierLimit;
  }

  get isClusterRejected(): boolean {
    return this._clusterRejected;
  }

  get activeLeaseCount(): number {
    return this.activeLeases.size;
  }

  /**
   * Request a lease from the cloud before dispatching work.
   * Resolves when cloud responds or rejects after requestTimeoutMs.
   */
  async requestLease(
    userId: string,
    queueItemId: string,
    jobId: string,
  ): Promise<LeaseRequestResult> {
    const correlationId = randomUUID();

    // Send lease_request via relay
    try {
      this.client.send({
        type: 'lease_request',
        correlationId,
        userId,
        queueItemId,
        jobId,
      } as RelayMessage);
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to send lease_request',
      );
      return { status: 'timeout' };
    }

    // Wait for response with timeout
    return new Promise<LeaseRequestResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        this.logger.warn({ correlationId, queueItemId }, 'Lease request timed out');
        resolve({ status: 'timeout' });
      }, this.config.requestTimeoutMs);

      this.pendingRequests.set(correlationId, { resolve, timer });
    });
  }

  /**
   * Release an active lease (workflow complete/pause/fail).
   * Stops heartbeat and sends lease_release to cloud.
   */
  releaseLease(leaseId: string): void {
    const lease = this.activeLeases.get(leaseId);
    if (lease) {
      clearInterval(lease.heartbeatInterval);
      this.activeLeases.delete(leaseId);
    }

    // Send lease_release (fire-and-forget)
    try {
      this.client.send({
        type: 'lease_release',
        leaseId,
      } as RelayMessage);
      this.logger.debug({ leaseId }, 'Lease released');
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), leaseId },
        'Failed to send lease_release (non-fatal)',
      );
    }
  }

  /**
   * Handle an inbound lease response from the relay.
   * Called by RelayBridge when it receives lease_granted or lease_denied.
   */
  handleLeaseResponse(msg: RelayLeaseGranted | RelayLeaseDenied): void {
    const pending = this.pendingRequests.get(msg.correlationId);
    if (!pending) {
      this.logger.warn(
        { correlationId: msg.correlationId, type: msg.type },
        'Received lease response for unknown correlation ID',
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.correlationId);

    if (msg.type === 'lease_granted') {
      this.logger.info({ leaseId: msg.leaseId }, 'Lease granted');
      pending.resolve({ status: 'granted', leaseId: msg.leaseId });
    } else {
      this.logger.info(
        { reason: msg.reason, correlationId: msg.correlationId },
        'Lease denied',
      );
      pending.resolve({ status: 'denied', reason: msg.reason });
    }
  }

  /**
   * Start heartbeat loop for a granted lease.
   * Called by WorkerDispatcher after successful lease grant.
   */
  startHeartbeat(leaseId: string, userId: string, queueItemId: string, workerId: string): void {
    const heartbeatInterval = setInterval(() => {
      this.sendHeartbeat(leaseId);
    }, this.config.heartbeatIntervalMs);

    const lease: Lease = {
      leaseId,
      userId,
      queueItemId,
      workerId,
      grantedAt: new Date().toISOString(),
      heartbeatInterval,
      consecutiveFailures: 0,
    };

    this.activeLeases.set(leaseId, lease);
    this.logger.debug({ leaseId, queueItemId }, 'Heartbeat started');
  }

  /** Handle slot_available from cloud */
  handleSlotAvailable(msg: RelaySlotAvailable): void {
    this.logger.info({ userId: msg.userId }, 'Slot available');
    this.emit('slot:available', { userId: msg.userId });
  }

  /** Handle tier_info from cloud */
  handleTierInfo(msg: RelayTierInfo): void {
    this._userTierLimit = msg.maxConcurrentWorkflows;
    this.logger.info(
      { tier: msg.tier, maxConcurrentWorkflows: msg.maxConcurrentWorkflows },
      'Tier info received',
    );
  }

  /** Handle cluster_rejected from cloud */
  handleClusterRejected(msg: RelayClusterRejected): void {
    this._clusterRejected = true;
    this.logger.error(
      {
        reason: msg.reason,
        tier: msg.tier,
        maxActiveClusters: msg.maxActiveClusters,
        currentActiveClusters: msg.currentActiveClusters,
      },
      'Cluster rejected by cloud',
    );
    this.emit('cluster:rejected', { reason: msg.reason, tier: msg.tier });
  }

  /**
   * Shutdown: clear all heartbeats, release active leases.
   */
  async shutdown(): Promise<void> {
    // Release all active leases
    for (const [leaseId] of this.activeLeases) {
      this.releaseLease(leaseId);
    }

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({ status: 'timeout' });
    }
    this.pendingRequests.clear();

    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private sendHeartbeat(leaseId: string): void {
    const lease = this.activeLeases.get(leaseId);
    if (!lease) return;

    try {
      this.client.send({
        type: 'lease_heartbeat',
        leaseId,
      } as RelayMessage);
      // Reset consecutive failures on success
      lease.consecutiveFailures = 0;
    } catch {
      lease.consecutiveFailures++;
      this.logger.warn(
        { leaseId, failures: lease.consecutiveFailures, max: this.config.maxHeartbeatFailures },
        'Heartbeat send failed',
      );

      if (lease.consecutiveFailures >= this.config.maxHeartbeatFailures) {
        this.logger.error({ leaseId }, 'Lease expired (heartbeat failures exceeded threshold)');
        clearInterval(lease.heartbeatInterval);
        const { queueItemId, workerId } = lease;
        this.activeLeases.delete(leaseId);
        this.emit('lease:expired', { leaseId, queueItemId, workerId });
      }
    }
  }
}
