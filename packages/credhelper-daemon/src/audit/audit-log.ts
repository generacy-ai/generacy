import { RingBuffer } from './ring-buffer.js';
import { flushBatch } from './transport.js';
import type { AuditAction, AuditEntry, AuditConfig } from './types.js';

const DEV_MODE =
  process.env['NODE_ENV'] !== 'production' ||
  process.env['CREDHELPER_AUDIT_ASSERT'] === '1';

const MAX_FIELD_LENGTH = 256;

/** Input to the `record()` API — caller provides action-specific fields. */
export interface AuditRecordInput {
  action: AuditAction;
  sessionId?: string;
  credentialId?: string;
  role?: string;
  pluginId?: string;
  success: boolean;
  errorCode?: string;
  exposureKind?: string;
  proxy?: { method: string; path: string; decision: 'allow' | 'deny' };
}

/**
 * Structured audit log with bounded ring buffer, timer-based flush,
 * and HTTP transport to the control-plane.
 */
export class AuditLog {
  private readonly buffer: RingBuffer<AuditEntry>;
  private readonly config: AuditConfig;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pendingFlush: Promise<void> | null = null;

  constructor(config: AuditConfig) {
    this.config = config;
    this.buffer = new RingBuffer<AuditEntry>(config.capacity);
  }

  /** Start the periodic flush timer. */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
    // Allow process to exit even if timer is active
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /** Stop the flush timer and perform a final flush. */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /** Record an audit entry. Triggers early flush if batch threshold is reached. */
  record(input: AuditRecordInput): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      action: input.action,
      actor: {
        workerId: this.config.workerId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      },
      clusterId: this.config.clusterId,
      success: input.success,
      ...(input.credentialId !== undefined ? { credentialId: input.credentialId } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.pluginId !== undefined ? { pluginId: input.pluginId } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.exposureKind !== undefined ? { exposureKind: input.exposureKind } : {}),
      ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
    };

    if (DEV_MODE) {
      assertFieldLengths(entry);
    }

    this.buffer.push(entry);

    // Early flush if batch threshold reached
    if (this.buffer.size >= this.config.maxBatchSize) {
      void this.flush();
    }
  }

  /** Flush buffered entries to the control-plane. */
  async flush(): Promise<void> {
    // Prevent concurrent flushes
    if (this.pendingFlush) {
      await this.pendingFlush;
      return;
    }

    if (this.buffer.size === 0) return;

    const { entries, dropped } = this.buffer.drain(this.config.maxBatchSize);
    if (entries.length === 0) return;

    this.pendingFlush = flushBatch(
      { entries, droppedSinceLastBatch: dropped },
      this.config.controlPlaneSocketPath,
    );

    try {
      await this.pendingFlush;
    } catch {
      // Transport failure — entries already drained; bounded by ring buffer capacity
    } finally {
      this.pendingFlush = null;
    }
  }

  /** Current buffer size (for testing). */
  get size(): number {
    return this.buffer.size;
  }
}

/** Dev-mode assertion: no string field in an audit entry exceeds 256 chars. */
function assertFieldLengths(entry: AuditEntry): void {
  const check = (obj: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
        throw new Error(
          `Audit field '${prefix}${key}' exceeds ${MAX_FIELD_LENGTH} chars (${value.length}). ` +
            'This may indicate accidental secret leakage.',
        );
      }
      if (typeof value === 'object' && value !== null) {
        check(value as Record<string, unknown>, `${prefix}${key}.`);
      }
    }
  };
  check(entry as unknown as Record<string, unknown>, '');
}
