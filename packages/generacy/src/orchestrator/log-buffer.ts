/**
 * LogBuffer and LogBufferManager for per-job log storage.
 *
 * LogBuffer wraps a RingBuffer to store log entries from streaming
 * stdout/stderr output of speckit operations. LogBufferManager manages
 * per-job buffers with automatic cleanup after a grace period.
 */
import { RingBuffer } from './event-bus.js';

/** A single log entry from a speckit operation's stdout/stderr. */
export interface LogEntry {
  /** Monotonic ID within the job's log buffer */
  id: number;
  /** Unix epoch ms */
  timestamp: number;
  /** 'stdout' or 'stderr' */
  stream: string;
  /** Speckit operation name (e.g. 'specify', 'plan', 'implement') */
  stepName: string;
  /** The log content */
  content: string;
  /** Task index for implement operation */
  taskIndex?: number;
  /** Task title for implement operation */
  taskTitle?: string;
}

/**
 * Per-job log buffer backed by a RingBuffer.
 *
 * Assigns monotonic IDs to entries so clients can do incremental
 * fetches with `getAfterId(sinceId)`.
 */
export class LogBuffer {
  private readonly buffer: RingBuffer<LogEntry>;
  private counter = 0;

  constructor(capacity = 10000) {
    this.buffer = new RingBuffer<LogEntry>(capacity);
  }

  /** Append a log entry, assigning a monotonic ID. Returns the full entry. */
  append(entry: Omit<LogEntry, 'id'>): LogEntry {
    const full: LogEntry = { ...entry, id: ++this.counter };
    this.buffer.push(full);
    return full;
  }

  /** Return all buffered entries in insertion order. */
  getAll(): LogEntry[] {
    return this.buffer.getAll();
  }

  /**
   * Return entries with IDs strictly greater than `sinceId`.
   *
   * ID mapping to RingBuffer logical index: entry with id=N was pushed
   * at logical index (N - 1). `getAfterIndex(N - 1)` returns items with
   * logical index > (N - 1), i.e. id > N — exactly what we want.
   */
  getAfterId(sinceId: number): LogEntry[] {
    return this.buffer.getAfterIndex(sinceId - 1);
  }

  /** Clear all entries and reset the ID counter. */
  clear(): void {
    this.buffer.clear();
    this.counter = 0;
  }

  /** Number of entries currently in the buffer. */
  get size(): number {
    return this.buffer.size;
  }
}

/**
 * Manages per-job LogBuffer instances with automatic cleanup.
 *
 * Buffers are lazily created on first access and scheduled for cleanup
 * after a job reaches a terminal state. The grace period (default 5 min)
 * aligns with the EventBus cleanup to give reconnecting clients time
 * to catch up.
 */
export class LogBufferManager {
  private readonly buffers = new Map<string, LogBuffer>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly capacity: number;
  private readonly gracePeriod: number;

  constructor(options?: { capacity?: number; gracePeriod?: number }) {
    this.capacity = options?.capacity ?? 10000;
    this.gracePeriod = options?.gracePeriod ?? 300_000; // 5 min
  }

  /** Get the log buffer for a job, creating one if it doesn't exist. */
  getOrCreate(jobId: string): LogBuffer {
    let buf = this.buffers.get(jobId);
    if (!buf) {
      buf = new LogBuffer(this.capacity);
      this.buffers.set(jobId, buf);
    }
    return buf;
  }

  /** Get the log buffer for a job, or undefined if none exists. */
  get(jobId: string): LogBuffer | undefined {
    return this.buffers.get(jobId);
  }

  /**
   * Schedule cleanup of a job's log buffer after the grace period.
   * Resets any existing timer for the same job.
   */
  scheduleCleanup(jobId: string): void {
    const existing = this.cleanupTimers.get(jobId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.buffers.get(jobId)?.clear();
      this.buffers.delete(jobId);
      this.cleanupTimers.delete(jobId);
    }, this.gracePeriod);
    this.cleanupTimers.set(jobId, timer);
  }

  /** Clean shutdown: clear all timers and buffers. */
  destroy(): void {
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
    this.buffers.clear();
  }
}
