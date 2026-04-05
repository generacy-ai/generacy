# Data Model: Per-User Execution Lease Protocol

## Core Entities

### Lease

Represents an active execution lease granted by the cloud for a single workflow dispatch.

```typescript
interface Lease {
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
```

### LeaseRequestResult

Result of a lease request attempt.

```typescript
type LeaseRequestResult =
  | { status: 'granted'; leaseId: string }
  | { status: 'denied'; reason: 'at_capacity' | string }
  | { status: 'timeout' };
```

### TierInfo

Subscription tier information received from cloud on relay connection.

```typescript
interface TierInfo {
  /** Subscription tier name */
  tier: 'free' | 'basic' | 'standard' | 'professional' | 'enterprise';
  /** Maximum concurrent workflows for this user */
  maxConcurrentWorkflows: number;
  /** Maximum active clusters for this user */
  maxActiveClusters: number;
}
```

### LeaseConfig

Configuration for lease behavior.

```typescript
interface LeaseConfig {
  /** Timeout for lease request response (ms). Default: 30000 */
  requestTimeoutMs: number;
  /** Interval between lease heartbeats (ms). Default: 30000 */
  heartbeatIntervalMs: number;
  /** Consecutive heartbeat failures before lease expiry. Default: 3 */
  maxHeartbeatFailures: number;
}
```

## Relay Message Types

### Outbound (Orchestrator → Cloud)

```typescript
/** Sent before dispatching work to a worker */
interface RelayLeaseRequest {
  type: 'lease_request';
  correlationId: string;
  userId: string;
  queueItemId: string;
  jobId: string;
}

/** Sent on workflow pause/complete/fail */
interface RelayLeaseRelease {
  type: 'lease_release';
  leaseId: string;
}

/** Sent every 30s for each active lease */
interface RelayLeaseHeartbeat {
  type: 'lease_heartbeat';
  leaseId: string;
}
```

### Inbound (Cloud → Orchestrator)

```typescript
/** Lease approved — dispatch may proceed */
interface RelayLeaseGranted {
  type: 'lease_granted';
  correlationId: string;
  leaseId: string;
}

/** Lease denied — user at capacity */
interface RelayLeaseDenied {
  type: 'lease_denied';
  correlationId: string;
  reason: 'at_capacity' | string;
}

/** A slot freed up — try dequeuing next item */
interface RelaySlotAvailable {
  type: 'slot_available';
  orgId: string;
  userId: string;
  timestamp: string;
  /** Number of available slots (future optimization) */
  availableSlots?: number;
}

/** User's tier info sent after relay handshake */
interface RelayTierInfo {
  type: 'tier_info';
  tier: string;
  maxConcurrentWorkflows: number;
  maxActiveClusters: number;
}

/** Cluster connection rejected — too many active clusters */
interface RelayClusterRejected {
  type: 'cluster_rejected';
  reason: string;
  tier: string;
  maxActiveClusters: number;
  currentActiveClusters: number;
}
```

## Extended Existing Types

### QueueItem (modified)

```typescript
interface QueueItem {
  // ... existing fields ...

  /** Cluster owner's user ID — used for lease requests */
  userId?: string;
}
```

### RelayMessage (modified)

```typescript
type RelayMessage =
  | RelayApiRequest
  | RelayApiResponse
  | RelayEvent
  | RelayJobEvent
  | RelayMetadata
  | RelayConversationInput
  | RelayConversationOutput
  // NEW lease protocol messages:
  | RelayLeaseRequest
  | RelayLeaseGranted
  | RelayLeaseDenied
  | RelayLeaseRelease
  | RelayLeaseHeartbeat
  | RelaySlotAvailable
  | RelayTierInfo
  | RelayClusterRejected;
```

## State Management

### LeaseManager Internal State

```
activLeases: Map<string, Lease>
  Key: leaseId
  Value: Full lease record with heartbeat tracking

pendingRequests: Map<string, PendingRequest>
  Key: correlationId (UUID)
  Value: { resolve, reject, timer }

userTierLimit: number | null
  Source: tier_info message from cloud
  null = not yet received (operate uncapped)

clusterRejected: boolean
  Source: cluster_rejected message
  true = stop all queue processing
```

## Validation Rules

| Field | Rule | Error |
|-------|------|-------|
| `correlationId` | UUID v4 format | Invalid correlation ID |
| `leaseId` | Non-empty string | Missing lease ID |
| `userId` | Non-empty string | Missing user ID for lease request |
| `requestTimeoutMs` | >= 5000 | Timeout too short |
| `heartbeatIntervalMs` | >= 5000 | Heartbeat interval too short |
| `maxHeartbeatFailures` | >= 1 | Must allow at least one failure |

## Relationships

```
QueueItem (1) ──── (0..1) Lease
  A queue item may have at most one active lease.
  The lease is created on lease_granted and destroyed on release/expiry.

Lease (many) ──── (1) User (via userId)
  Multiple leases may exist for the same user across different clusters.
  Total count is bounded by user's tier maxConcurrentWorkflows.

Lease (1) ──── (1) Worker (via workerId)
  Each lease maps to exactly one active worker.
  Worker lifecycle is tied to lease lifecycle.
```

## Per-Seat Tier Limits

| Tier | maxActiveClusters | maxConcurrentWorkflows |
|------|-------------------|------------------------|
| Free | 1 | 1 |
| Basic | 2 | 2 |
| Standard | 3 | 5 |
| Professional | 4 | 10 |
| Enterprise | Unlimited | Unlimited |
