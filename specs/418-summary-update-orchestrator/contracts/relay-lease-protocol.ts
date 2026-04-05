/**
 * Relay Lease Protocol — Message type contracts for #418.
 *
 * Defines the wire format for all lease-related messages exchanged
 * between the orchestrator and cloud via the relay WebSocket.
 *
 * These types will be added to the existing RelayMessage union
 * in packages/orchestrator/src/types/relay.ts.
 */

// =============================================================================
// Outbound Messages (Orchestrator → Cloud)
// =============================================================================

/**
 * Request a lease before dispatching work to a worker.
 * Sent after claiming a queue item, before starting the worker handler.
 *
 * Cloud responds with lease_granted or lease_denied.
 * Orchestrator times out after 30s if no response.
 */
export interface RelayLeaseRequest {
  type: 'lease_request';
  /** UUID v4 — used to correlate with lease_granted/lease_denied response */
  correlationId: string;
  /** Cluster owner's user ID — all workflows count against this user's limits */
  userId: string;
  /** Unique identifier for the queue item (owner/repo#issue) */
  queueItemId: string;
  /** Job identifier (may be same as queueItemId for simple cases) */
  jobId: string;
}

/**
 * Release an active lease when workflow completes, pauses, or fails.
 * Fire-and-forget — no response expected.
 */
export interface RelayLeaseRelease {
  type: 'lease_release';
  /** The lease ID received in lease_granted */
  leaseId: string;
}

/**
 * Heartbeat for an active lease. Sent every 30s.
 * Fire-and-forget — cloud does not acknowledge.
 *
 * If the WebSocket send fails 3 consecutive times, the orchestrator
 * treats the lease as expired locally.
 */
export interface RelayLeaseHeartbeat {
  type: 'lease_heartbeat';
  /** The lease ID received in lease_granted */
  leaseId: string;
}

// =============================================================================
// Inbound Messages (Cloud → Orchestrator)
// =============================================================================

/**
 * Lease granted — the orchestrator may proceed with dispatching the worker.
 */
export interface RelayLeaseGranted {
  type: 'lease_granted';
  /** Matches the correlationId from the lease_request */
  correlationId: string;
  /** Unique lease ID — used for heartbeat and release */
  leaseId: string;
}

/**
 * Lease denied — the user is at capacity.
 * The orchestrator should re-enqueue the item and wait for slot_available.
 */
export interface RelayLeaseDenied {
  type: 'lease_denied';
  /** Matches the correlationId from the lease_request */
  correlationId: string;
  /** Reason for denial */
  reason: 'at_capacity' | string;
}

/**
 * A workflow slot has become available for this user.
 * Broadcast to all clusters owned by the user.
 *
 * On receipt, the orchestrator should dequeue one item and
 * send a lease_request. If denied, it lost the race — wait for the next one.
 */
export interface RelaySlotAvailable {
  type: 'slot_available';
  /** Organization ID */
  orgId: string;
  /** User ID whose slot freed up */
  userId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /**
   * Number of available slots (optional, future optimization).
   * When present, orchestrator may dequeue up to this many items.
   * When absent, dequeue one item.
   */
  availableSlots?: number;
}

/**
 * User's subscription tier information.
 * Sent by cloud after relay handshake completes.
 *
 * Used by orchestrator to cap effective worker count at
 * min(configuredWorkers, maxConcurrentWorkflows).
 */
export interface RelayTierInfo {
  type: 'tier_info';
  /** Subscription tier name */
  tier: 'free' | 'basic' | 'standard' | 'professional' | 'enterprise';
  /** Maximum concurrent workflows for this user's tier */
  maxConcurrentWorkflows: number;
  /** Maximum active clusters for this user's tier */
  maxActiveClusters: number;
}

/**
 * Cluster connection rejected by cloud.
 * Sent when the user has reached their active cluster limit.
 *
 * The orchestrator should surface this error to the user and
 * prevent queue processing.
 */
export interface RelayClusterRejected {
  type: 'cluster_rejected';
  /** Human-readable reason */
  reason: string;
  /** User's current tier */
  tier: string;
  /** Maximum clusters allowed */
  maxActiveClusters: number;
  /** Current active cluster count (including this attempted connection) */
  currentActiveClusters: number;
}

// =============================================================================
// LeaseManager Interface
// =============================================================================

export type LeaseRequestResult =
  | { status: 'granted'; leaseId: string }
  | { status: 'denied'; reason: string }
  | { status: 'timeout' };

/**
 * LeaseManager interface — owns the full lease lifecycle.
 *
 * Injected into WorkerDispatcher and RelayBridge.
 * Extends EventEmitter with typed events:
 *   - 'lease:expired' → { leaseId, queueItemId, workerId }
 *   - 'slot:available' → { userId }
 *   - 'cluster:rejected' → { reason, tier }
 */
export interface ILeaseManager {
  /**
   * Request a lease from the cloud before dispatching work.
   * Resolves when cloud responds or rejects after requestTimeoutMs.
   */
  requestLease(
    userId: string,
    queueItemId: string,
    jobId: string,
  ): Promise<LeaseRequestResult>;

  /**
   * Release an active lease (workflow complete/pause/fail).
   * Stops heartbeat and sends lease_release to cloud.
   */
  releaseLease(leaseId: string): void;

  /**
   * Handle an inbound lease response from the relay.
   * Called by RelayBridge when it receives lease_granted or lease_denied.
   */
  handleLeaseResponse(
    msg: RelayLeaseGranted | RelayLeaseDenied,
  ): void;

  /** Handle slot_available from cloud */
  handleSlotAvailable(msg: RelaySlotAvailable): void;

  /** Handle tier_info from cloud */
  handleTierInfo(msg: RelayTierInfo): void;

  /** Handle cluster_rejected from cloud */
  handleClusterRejected(msg: RelayClusterRejected): void;

  /** Current user tier limit (null if tier_info not yet received) */
  readonly userTierLimit: number | null;

  /** Whether this cluster has been rejected */
  readonly isClusterRejected: boolean;

  /** Number of active leases */
  readonly activeLeaseCount: number;
}

// =============================================================================
// Configuration
// =============================================================================

export interface LeaseConfig {
  /** Timeout for lease_request response (ms). Default: 30000 */
  requestTimeoutMs: number;
  /** Interval between lease heartbeats (ms). Default: 30000 */
  heartbeatIntervalMs: number;
  /** Consecutive heartbeat send failures before local expiry. Default: 3 */
  maxHeartbeatFailures: number;
}
