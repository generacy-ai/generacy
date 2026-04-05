/**
 * Lease types for per-user execution lease protocol (#418).
 */

// =============================================================================
// Core Types
// =============================================================================

/**
 * Represents an active execution lease granted by the cloud.
 */
export interface Lease {
  /** Unique lease ID assigned by cloud in lease_granted */
  leaseId: string;
  /** User ID (cluster owner) this lease is charged against */
  userId: string;
  /** Queue item ID this lease is for */
  queueItemId: string;
  /** Worker ID processing this lease */
  workerId: string;
  /** When the lease was granted (ISO 8601) */
  grantedAt: string;
  /** Heartbeat interval handle */
  heartbeatInterval: NodeJS.Timeout;
  /** Count of consecutive heartbeat send failures */
  consecutiveFailures: number;
}

/**
 * Result of a lease request attempt.
 */
export type LeaseRequestResult =
  | { status: 'granted'; leaseId: string }
  | { status: 'denied'; reason: string }
  | { status: 'timeout' };

/**
 * Subscription tier information received from cloud.
 */
export interface TierInfo {
  /** Subscription tier name */
  tier: 'free' | 'basic' | 'standard' | 'professional' | 'enterprise';
  /** Maximum concurrent workflows for this user */
  maxConcurrentWorkflows: number;
  /** Maximum active clusters for this user */
  maxActiveClusters: number;
}

/**
 * Configuration for lease behavior.
 */
export interface LeaseConfig {
  /** Timeout for lease request response (ms). Default: 30000 */
  requestTimeoutMs: number;
  /** Interval between lease heartbeats (ms). Default: 30000 */
  heartbeatIntervalMs: number;
  /** Consecutive heartbeat failures before lease expiry. Default: 3 */
  maxHeartbeatFailures: number;
}

// =============================================================================
// Relay Message Types (Outbound: Orchestrator → Cloud)
// =============================================================================

/** Sent before dispatching work to a worker */
export interface RelayLeaseRequest {
  type: 'lease_request';
  /** UUID v4 — correlate with response */
  correlationId: string;
  /** Cluster owner's user ID */
  userId: string;
  /** Queue item identifier */
  queueItemId: string;
  /** Job identifier */
  jobId: string;
}

/** Sent on workflow pause/complete/fail */
export interface RelayLeaseRelease {
  type: 'lease_release';
  /** Lease ID from lease_granted */
  leaseId: string;
}

/** Sent every 30s for each active lease */
export interface RelayLeaseHeartbeat {
  type: 'lease_heartbeat';
  /** Lease ID from lease_granted */
  leaseId: string;
}

// =============================================================================
// Relay Message Types (Inbound: Cloud → Orchestrator)
// =============================================================================

/** Lease approved — dispatch may proceed */
export interface RelayLeaseGranted {
  type: 'lease_granted';
  /** Matches correlationId from lease_request */
  correlationId: string;
  /** Unique lease ID for heartbeat and release */
  leaseId: string;
}

/** Lease denied — user at capacity */
export interface RelayLeaseDenied {
  type: 'lease_denied';
  /** Matches correlationId from lease_request */
  correlationId: string;
  /** Reason for denial */
  reason: 'at_capacity' | string;
}

/** A slot freed up — try dequeuing next item */
export interface RelaySlotAvailable {
  type: 'slot_available';
  /** Organization ID */
  orgId: string;
  /** User ID whose slot freed up */
  userId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Number of available slots (future optimization) */
  availableSlots?: number;
}

/** User's tier info sent after relay handshake */
export interface RelayTierInfo {
  type: 'tier_info';
  /** Subscription tier name */
  tier: 'free' | 'basic' | 'standard' | 'professional' | 'enterprise';
  /** Maximum concurrent workflows */
  maxConcurrentWorkflows: number;
  /** Maximum active clusters */
  maxActiveClusters: number;
}

/** Cluster connection rejected */
export interface RelayClusterRejected {
  type: 'cluster_rejected';
  /** Human-readable reason */
  reason: string;
  /** User's current tier */
  tier: string;
  /** Maximum clusters allowed */
  maxActiveClusters: number;
  /** Current active cluster count */
  currentActiveClusters: number;
}

// =============================================================================
// LeaseManager Interface
// =============================================================================

/**
 * LeaseManager interface — owns the full lease lifecycle.
 * Injected into WorkerDispatcher and RelayBridge.
 *
 * Extends EventEmitter with typed events:
 *   - 'lease:expired' → { leaseId, queueItemId, workerId }
 *   - 'slot:available' → { userId }
 *   - 'cluster:rejected' → { reason, tier }
 */
export interface ILeaseManager {
  requestLease(userId: string, queueItemId: string, jobId: string): Promise<LeaseRequestResult>;
  releaseLease(leaseId: string): void;
  handleLeaseResponse(msg: RelayLeaseGranted | RelayLeaseDenied): void;
  handleSlotAvailable(msg: RelaySlotAvailable): void;
  handleTierInfo(msg: RelayTierInfo): void;
  handleClusterRejected(msg: RelayClusterRejected): void;
  readonly userTierLimit: number | null;
  readonly isClusterRejected: boolean;
  readonly activeLeaseCount: number;
  on(event: 'lease:expired', listener: (data: { leaseId: string; queueItemId: string; workerId: string }) => void): this;
  on(event: 'slot:available', listener: (data: { userId: string }) => void): this;
  on(event: 'cluster:rejected', listener: (data: { reason: string; tier: string }) => void): this;
  removeAllListeners(event?: string): this;
}
