import { z } from 'zod';

// ---------------------------------------------------------------------------
// Audit action — all credential lifecycle events tracked by the daemon.
// ---------------------------------------------------------------------------

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

export type AuditAction = z.infer<typeof AuditActionSchema>;

// ---------------------------------------------------------------------------
// Audit entry — a single structured log record.
// ---------------------------------------------------------------------------

export const AuditEntrySchema = z.object({
  /** ISO-8601 timestamp */
  timestamp: z.string(),
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
  proxy: z
    .object({
      method: z.string(),
      path: z.string(),
      decision: z.enum(['allow', 'deny']),
    })
    .optional(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ---------------------------------------------------------------------------
// Audit batch — payload sent to the control-plane.
// ---------------------------------------------------------------------------

export const AuditBatchSchema = z.object({
  entries: z.array(AuditEntrySchema).max(50),
  droppedSinceLastBatch: z.number().int().min(0),
});

export type AuditBatch = z.infer<typeof AuditBatchSchema>;

// ---------------------------------------------------------------------------
// Audit config — runtime configuration for the AuditLog subsystem.
// ---------------------------------------------------------------------------

export interface AuditConfig {
  /** Ring buffer capacity. @default 5000 */
  capacity: number;
  /** Flush interval in milliseconds. @default 1000 */
  flushIntervalMs: number;
  /** Maximum entries per batch payload. @default 50 */
  maxBatchSize: number;
  /** Unix socket path for the control-plane. @default '/run/generacy-control-plane/control.sock' */
  controlPlaneSocketPath: string;
  /** Cluster identity from GENERACY_CLUSTER_ID. */
  clusterId: string;
  /** Worker identity from GENERACY_WORKER_ID. */
  workerId: string;
}
