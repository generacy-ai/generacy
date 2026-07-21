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
  RelayLeaseResponse,
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
  /** Outstanding release correlationIds awaiting their `released` ack */
  private readonly pendingReleases = new Set<string>();

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

    // Send lease_release (fire-and-forget). The cloud REQUIRES a
    // correlationId and refuses the release without one; it acks with a
    // lease_response {status: 'released'} we swallow via pendingReleases.
    const correlationId = randomUUID();
    try {
      this.client.send({
        type: 'lease_release',
        correlationId,
        leaseId,
      } as RelayMessage);
      this.pendingReleases.add(correlationId);
      // Drop the tracking entry if the ack never arrives.
      const timer = setTimeout(() => {
        this.pendingReleases.delete(correlationId);
      }, this.config.requestTimeoutMs);
      timer.unref?.();
      this.logger.debug({ leaseId }, 'Lease released');
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), leaseId },
        'Failed to send lease_release (non-fatal)',
      );
    }
  }

  /**
   * Handle an inbound lease_response from the relay (#1016).
   * Answers both lease_request (granted/denied/error) and lease_release
   * (released) by correlationId.
   */
  handleLeaseResponse(msg: RelayLeaseResponse): void {
    // Acks for fire-and-forget releases are expected and silently consumed.
    if (this.pendingReleases.delete(msg.correlationId)) {
      this.logger.debug({ correlationId: msg.correlationId, status: msg.status }, 'Lease release acked');
      return;
    }

    const pending = this.pendingRequests.get(msg.correlationId);
    if (!pending) {
      this.logger.warn(
        { correlationId: msg.correlationId, status: msg.status },
        'Received lease response for unknown correlation ID',
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.correlationId);

    switch (msg.status) {
      case 'granted': {
        if (!msg.leaseId) {
          this.logger.error(
            { correlationId: msg.correlationId },
            'lease_response granted without leaseId — treating as error',
          );
          pending.resolve({ status: 'error', message: 'granted response missing leaseId' });
          return;
        }
        this.logger.info({ leaseId: msg.leaseId }, 'Lease granted');
        pending.resolve({ status: 'granted', leaseId: msg.leaseId });
        return;
      }
      case 'denied': {
        // The denial payload carries the tier's concurrency limit — the only
        // place the cloud currently reports it (tier_info is never sent).
        if (typeof msg.limit === 'number') {
          this._userTierLimit = msg.limit;
        }
        this.logger.info(
          { reason: msg.reason, currentCount: msg.currentCount, limit: msg.limit },
          'Lease denied',
        );
        pending.resolve({ status: 'denied', reason: msg.reason ?? 'denied' });
        return;
      }
      case 'released': {
        // A release ack matched a request correlation — protocol confusion,
        // but resolve as error rather than leaving the caller to time out.
        pending.resolve({ status: 'error', message: 'unexpected released status for lease_request' });
        return;
      }
      case 'error': {
        this.logger.warn(
          { correlationId: msg.correlationId, message: msg.message },
          'Lease request errored on cloud',
        );
        pending.resolve({ status: 'error', message: msg.message ?? 'unknown cloud error' });
        return;
      }
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
        tierName: msg.tierName,
        currentLimit: msg.currentLimit,
        upgradeHint: msg.upgradeHint,
      },
      'Cluster rejected by cloud',
    );
    this.emit('cluster:rejected', { reason: msg.reason, tier: msg.tierName ?? 'unknown' });
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
