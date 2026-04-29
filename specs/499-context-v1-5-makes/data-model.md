# Data Model: Credential Audit Log

**Feature**: #499 — Audit log writer in credhelper-daemon
**Date**: 2026-04-29

## Core Entities

### AuditEntry

A single audit record for one credential operation.

```typescript
export interface AuditEntry {
  /** ISO-8601 timestamp */
  timestamp: string;

  /** Operation that was performed */
  action: AuditAction;

  /** Actor identity */
  actor: {
    /** Worker container hostname (GENERACY_WORKER_ID) */
    workerId: string;
    /** Credhelper session ID (if within a session context) */
    sessionId?: string;
  };

  /** Cluster identity (GENERACY_CLUSTER_ID) */
  clusterId: string;

  /** Credential being operated on (omitted for session-level events) */
  credentialId?: string;

  /** Role that authorized this operation */
  role?: string;

  /** Plugin type that handled the operation */
  pluginId?: string;

  /** Whether the operation succeeded */
  success: boolean;

  /** Error code on failure (from CredhelperError.code) */
  errorCode?: string;

  /** Exposure kind (for render events) */
  exposureKind?: string;

  /** Proxy action details (for docker/localhost proxy events) */
  proxy?: {
    /** HTTP method of proxied request */
    method: string;
    /** Path of proxied request */
    path: string;
    /** Whether the request was allowed or denied */
    decision: 'allow' | 'deny';
  };
}
```

### AuditAction

Enumerated action types.

```typescript
export type AuditAction =
  | 'session.begin'
  | 'session.end'
  | 'credential.mint'
  | 'credential.resolve'
  | 'credential.refresh'
  | 'exposure.render'
  | 'proxy.docker'
  | 'proxy.localhost';
```

### AuditBatch

Batch payload sent to the control-plane.

```typescript
export interface AuditBatch {
  /** Array of audit entries in this batch (max 50) */
  entries: AuditEntry[];

  /** Number of entries dropped from ring buffer since last batch.
   *  Always present; 0 if no drops occurred. */
  droppedSinceLastBatch: number;
}
```

### AuditConfig

Configuration for the audit module.

```typescript
export interface AuditConfig {
  /** Ring buffer capacity. @default 5000 */
  capacity: number;

  /** Flush interval in milliseconds. @default 1000 */
  flushIntervalMs: number;

  /** Maximum entries per batch. @default 50 */
  maxBatchSize: number;

  /** Control-plane socket path for batch delivery.
   *  @default '/run/generacy-control-plane/control.sock' */
  controlPlaneSocketPath: string;

  /** Cluster ID stamped on every entry (from GENERACY_CLUSTER_ID) */
  clusterId: string;

  /** Worker ID stamped on every entry (from GENERACY_WORKER_ID) */
  workerId: string;
}
```

## Zod Schemas

### AuditEntrySchema (in credhelper-daemon)

```typescript
import { z } from 'zod';

export const AuditActionSchema = z.enum([
  'session.begin',
  'session.end',
  'credential.mint',
  'credential.resolve',
  'credential.refresh',
  'exposure.render',
  'proxy.docker',
  'proxy.localhost',
]);

export const AuditEntrySchema = z.object({
  timestamp: z.string().datetime(),
  action: AuditActionSchema,
  actor: z.object({
    workerId: z.string(),
    sessionId: z.string().optional(),
  }),
  clusterId: z.string(),
  credentialId: z.string().optional(),
  role: z.string().optional(),
  pluginId: z.string().optional(),
  success: z.boolean(),
  errorCode: z.string().optional(),
  exposureKind: z.string().optional(),
  proxy: z.object({
    method: z.string(),
    path: z.string(),
    decision: z.enum(['allow', 'deny']),
  }).optional(),
});

export const AuditBatchSchema = z.object({
  entries: z.array(AuditEntrySchema).max(50),
  droppedSinceLastBatch: z.number().int().min(0),
});
```

### RoleConfig Schema Extension (in credhelper shared package)

```typescript
// Addition to packages/credhelper/src/schemas/roles.ts
export const RoleAuditConfigSchema = z.object({
  recordAllProxy: z.boolean().optional(),
});

// Added to RoleConfigSchema:
export const RoleConfigSchema = z.object({
  // ... existing fields ...
  audit: RoleAuditConfigSchema.optional(),
});
```

## DaemonConfig Extension

```typescript
// Addition to packages/credhelper-daemon/src/types.ts
export interface DaemonConfig {
  // ... existing fields ...

  /** Cluster ID from GENERACY_CLUSTER_ID env var */
  clusterId?: string;

  /** Worker ID from GENERACY_WORKER_ID env var */
  workerId?: string;
}
```

## RingBuffer<T>

Generic bounded circular buffer.

```typescript
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number;   // Next write position
  private count: number;  // Current number of entries
  private dropped: number; // Entries dropped since last drain

  constructor(private readonly capacity: number);

  /** Push an entry; drops oldest if at capacity. */
  push(entry: T): void;

  /** Drain up to `max` entries from the buffer (FIFO). Returns entries and resets dropped counter. */
  drain(max: number): { entries: T[]; dropped: number };

  /** Current number of entries in the buffer. */
  get size(): number;

  /** Number of entries dropped since last drain. */
  get droppedCount(): number;
}
```

## Relationships

```
AuditLog (credhelper-daemon)
  ├── owns → RingBuffer<AuditEntry>
  ├── uses → AuditConfig (capacity, flush interval, transport target)
  ├── method record() → creates AuditEntry → pushes to RingBuffer
  └── method flush() → drains RingBuffer → creates AuditBatch → HTTP POST

SessionManager
  ├── holds → AuditLog reference
  ├── calls → auditLog.record() at beginSession/endSession
  └── wraps → plugin.mint()/resolve() with audit try/catch

ExposureRenderer
  └── calls → auditLog.record() per renderPluginExposure()

DockerProxyHandler
  └── calls → auditLog.record() per allow/deny (sampled 1/100)

ControlPlaneServer
  ├── route → POST /internal/audit-batch
  ├── validates → AuditBatchSchema
  └── emits → relay.pushEvent('cluster.audit', entry) per entry

RoleConfig
  └── audit?.recordAllProxy → controls proxy sampling rate
```
