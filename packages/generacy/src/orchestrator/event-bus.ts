/**
 * EventBus module for SSE event buffering and broadcasting.
 */
import type { ServerResponse } from 'node:http';
import type { Job, JobEvent, EventFilters } from './types.js';
import type { JobQueue } from './job-queue.js';

/**
 * A fixed-capacity circular buffer that evicts oldest items when full.
 *
 * Tracks a `baseIndex` representing the total number of items ever evicted,
 * so callers can map external IDs (like monotonic counters) to buffer positions.
 */
export class RingBuffer<T> {
  private readonly _capacity: number;
  private readonly buffer: (T | undefined)[];
  private head = 0;
  private _size = 0;
  private _baseIndex = 0;

  constructor(capacity = 1000) {
    if (capacity < 1) {
      throw new Error('RingBuffer capacity must be at least 1');
    }
    this._capacity = capacity;
    this.buffer = new Array<T | undefined>(capacity);
  }

  /** Number of items currently in the buffer. */
  get size(): number {
    return this._size;
  }

  /** Maximum number of items the buffer can hold. */
  get capacity(): number {
    return this._capacity;
  }

  /**
   * The number of items that have been evicted over the buffer's lifetime.
   * An item inserted at logical index N is at buffer position (N - baseIndex).
   */
  get baseIndex(): number {
    return this._baseIndex;
  }

  /**
   * Push an item into the buffer. O(1).
   * When the buffer is full the oldest item is evicted.
   */
  push(item: T): void {
    if (this._size === this._capacity) {
      // Overwrite the oldest slot — the head is already pointing at it
      this.buffer[this.head] = item;
      this.head = (this.head + 1) % this._capacity;
      this._baseIndex++;
    } else {
      const writeIndex = (this.head + this._size) % this._capacity;
      this.buffer[writeIndex] = item;
      this._size++;
    }
  }

  /**
   * Return all buffered items in insertion order.
   */
  getAll(): T[] {
    if (this._size === 0) return [];

    const result: T[] = [];
    for (let i = 0; i < this._size; i++) {
      const index = (this.head + i) % this._capacity;
      result.push(this.buffer[index] as T);
    }
    return result;
  }

  /**
   * Return all items whose logical index is strictly greater than `startIndex`.
   *
   * Logical index = baseIndex + position-in-current-buffer.
   * The first item currently in the buffer has logical index `baseIndex`,
   * the second has `baseIndex + 1`, etc.
   *
   * If `startIndex` is before the buffer's range (i.e. already evicted),
   * all buffered items are returned.
   */
  getAfterIndex(startIndex: number): T[] {
    if (this._size === 0) return [];

    // How many items to skip from the start of the current buffer
    const skip = startIndex - this._baseIndex + 1;

    if (skip <= 0) {
      // The requested index is before (or at the start of) our buffer — return everything
      return this.getAll();
    }

    if (skip >= this._size) {
      // The requested index is beyond what we have
      return [];
    }

    const result: T[] = [];
    for (let i = skip; i < this._size; i++) {
      const index = (this.head + i) % this._capacity;
      result.push(this.buffer[index] as T);
    }
    return result;
  }

  /**
   * Remove all items and reset state.
   */
  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this._size = 0;
    this._baseIndex = 0;
  }
}

/**
 * Configuration options for the EventBus.
 */
export interface EventBusOptions {
  /** Per-job ring buffer capacity (default: 1000) */
  bufferSize?: number;

  /** Milliseconds to keep buffers after a job reaches terminal state (default: 300000 / 5 min) */
  gracePeriod?: number;

  /** Milliseconds between SSE heartbeat pings (default: 30000 / 30s) */
  heartbeatInterval?: number;

  /** Job queue used for filter evaluation on global subscribers */
  jobQueue: JobQueue;

  /** Optional logger */
  logger?: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
}

/** A global subscriber entry with its associated filters. */
interface GlobalSubscriber {
  res: ServerResponse;
  filters: EventFilters;
}

/**
 * Format a JobEvent as an SSE text frame.
 *
 * Wire format:
 * ```
 * event: {type}
 * id: {id}
 * data: {json}
 *
 * ```
 */
function formatSSE(event: JobEvent): string {
  return `event: ${event.type}\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * EventBus handles event buffering (per-job ring buffers) and broadcasting
 * to SSE subscribers. It is the core publish/subscribe component for
 * real-time job event streaming.
 */
export class EventBus {
  /** Per-job ring buffers */
  private readonly buffers = new Map<string, RingBuffer<JobEvent>>();

  /** Per-job monotonic ID counters */
  private readonly counters = new Map<string, number>();

  /** Per-job SSE subscriber connections */
  private readonly subscribers = new Map<string, Set<ServerResponse>>();

  /** Global SSE subscriber connections with filters */
  private readonly globalSubscribers = new Set<GlobalSubscriber>();

  /** Grace period cleanup timers for terminal jobs */
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly bufferSize: number;
  private readonly gracePeriod: number;
  private readonly heartbeatInterval: number;
  private readonly jobQueue: JobQueue;
  private readonly logger?: EventBusOptions['logger'];

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: EventBusOptions) {
    this.bufferSize = options.bufferSize ?? 1000;
    this.gracePeriod = options.gracePeriod ?? 300_000;
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
    this.jobQueue = options.jobQueue;
    this.logger = options.logger;
  }

  /**
   * Publish an event for a job.
   *
   * Assigns a monotonic string ID, buffers the event in the job's ring buffer,
   * and broadcasts to all per-job and matching global subscribers.
   *
   * Global subscribers are filtered by looking up the job's current metadata
   * from the job queue. Filters combine with AND logic:
   * - `tags`: job must have at least one matching tag
   * - `workflow`: job's workflow must match (string comparison)
   * - `status`: job's current status must be in the filter list
   */
  async publish(jobId: string, event: Omit<JobEvent, 'id'>): Promise<JobEvent> {
    // Assign monotonic ID
    const counter = (this.counters.get(jobId) ?? 0) + 1;
    this.counters.set(jobId, counter);

    const fullEvent: JobEvent = { ...event, id: String(counter) };

    // Get or create the per-job ring buffer
    let buffer = this.buffers.get(jobId);
    if (!buffer) {
      buffer = new RingBuffer<JobEvent>(this.bufferSize);
      this.buffers.set(jobId, buffer);
    }
    buffer.push(fullEvent);

    // Broadcast to per-job subscribers
    const frame = formatSSE(fullEvent);
    const jobSubs = this.subscribers.get(jobId);
    if (jobSubs) {
      for (const res of jobSubs) {
        try {
          res.write(frame);
        } catch {
          // Connection dead — clean it up
          this.removeSubscriber(res);
        }
      }
    }

    // Broadcast to matching global subscribers
    if (this.globalSubscribers.size > 0) {
      const hasFilters = this.anySubscriberHasFilters();
      const job = hasFilters ? await this.jobQueue.getJob(jobId) : null;

      for (const sub of this.globalSubscribers) {
        if (!this.matchesFilters(sub.filters, job)) continue;
        try {
          sub.res.write(frame);
        } catch {
          this.globalSubscribers.delete(sub);
        }
      }
    }

    return fullEvent;
  }

  /**
   * Subscribe to a single job's event stream.
   *
   * If `lastEventId` is provided, replays buffered events after that ID
   * before switching to live mode. If the ID is not found in the buffer,
   * all buffered events are replayed.
   *
   * Automatically unsubscribes when the response connection closes.
   */
  subscribe(jobId: string, res: ServerResponse, lastEventId?: string): void {
    // Get or create per-job subscriber set
    let jobSubs = this.subscribers.get(jobId);
    if (!jobSubs) {
      jobSubs = new Set<ServerResponse>();
      this.subscribers.set(jobId, jobSubs);
    }
    jobSubs.add(res);

    // Replay buffered events if requested
    if (lastEventId !== undefined) {
      const buffer = this.buffers.get(jobId);
      if (buffer) {
        const eventIdNum = parseInt(lastEventId, 10);
        let events: JobEvent[];

        if (isNaN(eventIdNum)) {
          // Unknown format — replay all
          events = buffer.getAll();
        } else {
          // Replay events after the given counter value.
          // The counter maps to the logical index: counter - 1 + baseIndex
          // because counter starts at 1 and the first buffered item's logical
          // index is baseIndex. Actually the RingBuffer's getAfterIndex uses
          // logical indices where the first item ever pushed (counter=1) has
          // logical index 0. But after eviction, baseIndex shifts.
          //
          // Counter N was stored at logical index (N - 1).
          // getAfterIndex(N - 1) returns items with logical index > (N - 1),
          // which means counter > N — exactly what we want.
          events = buffer.getAfterIndex(eventIdNum - 1);
        }

        for (const event of events) {
          try {
            res.write(formatSSE(event));
          } catch {
            this.removeSubscriber(res);
            return;
          }
        }
      }
    }

    // Auto-unsubscribe on connection close
    res.on('close', () => {
      this.removeSubscriber(res);
    });
  }

  /**
   * Subscribe to events from all jobs, optionally filtered.
   *
   * If `lastEventId` is provided (format `{jobId}:{counter}`), replays
   * buffered events after that ID from the specified job's buffer, then
   * replays all buffered events from other jobs' buffers (filtered).
   *
   * Filter matching is applied during replay: only events from jobs that
   * match the subscriber's filters are sent.
   */
  async subscribeAll(
    res: ServerResponse,
    filters: EventFilters,
    lastEventId?: string,
  ): Promise<void> {
    const sub: GlobalSubscriber = { res, filters };
    this.globalSubscribers.add(sub);

    const hasFilters =
      (filters.tags !== undefined && filters.tags.length > 0) ||
      filters.workflow !== undefined ||
      (filters.status !== undefined && filters.status.length > 0);

    // Replay from buffers if lastEventId provided (format: {jobId}:{counter})
    if (lastEventId !== undefined) {
      const colonIdx = lastEventId.lastIndexOf(':');
      if (colonIdx > 0) {
        const replayJobId = lastEventId.substring(0, colonIdx);
        const replayCounter = parseInt(lastEventId.substring(colonIdx + 1), 10);

        if (!isNaN(replayCounter)) {
          // Replay events from the specified job after the given counter
          const dead = await this.replayJobBuffer(
            replayJobId,
            replayCounter,
            res,
            sub,
            filters,
            hasFilters,
          );
          if (dead) return;

          // Replay all buffered events from other jobs (filtered)
          for (const [jobId, buffer] of this.buffers) {
            if (jobId === replayJobId) continue;
            const events = buffer.getAll();
            const dead = await this.replayEventsFiltered(
              jobId,
              events,
              res,
              sub,
              filters,
              hasFilters,
            );
            if (dead) return;
          }
        }
      }
    }

    // Auto-unsubscribe on connection close
    res.on('close', () => {
      this.globalSubscribers.delete(sub);
    });
  }

  /**
   * Remove a response from all subscriber sets (per-job and global).
   */
  unsubscribe(res: ServerResponse): void {
    this.removeSubscriber(res);
  }

  /**
   * Schedule cleanup of a job's buffers and subscriber data after the grace period.
   */
  scheduleCleanup(jobId: string): void {
    // Clear any existing timer for this job
    const existing = this.cleanupTimers.get(jobId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.buffers.get(jobId)?.clear();
      this.buffers.delete(jobId);
      this.counters.delete(jobId);
      this.subscribers.delete(jobId);
      this.cleanupTimers.delete(jobId);
      this.logger?.info('Cleaned up event buffer for job', { jobId });
    }, this.gracePeriod);

    this.cleanupTimers.set(jobId, timer);
  }

  /**
   * Close all per-job SSE connections for a job.
   * Sends `res.end()` to each subscriber and removes them from the set.
   */
  closeJobSubscribers(jobId: string): void {
    const jobSubs = this.subscribers.get(jobId);
    if (!jobSubs) return;

    for (const res of jobSubs) {
      try {
        res.end();
      } catch {
        // Already closed, ignore
      }
    }
    jobSubs.clear();
  }

  /**
   * Return all buffered events for a job (for replay-and-close on terminal jobs).
   */
  getBufferedEvents(jobId: string): JobEvent[] {
    const buffer = this.buffers.get(jobId);
    return buffer ? buffer.getAll() : [];
  }

  /**
   * Start the heartbeat interval that sends `: ping\n\n` to all active SSE connections.
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      const ping = ': ping\n\n';

      // Ping per-job subscribers
      for (const [, jobSubs] of this.subscribers) {
        for (const res of jobSubs) {
          try {
            res.write(ping);
          } catch {
            this.removeSubscriber(res);
          }
        }
      }

      // Ping global subscribers
      for (const sub of this.globalSubscribers) {
        try {
          sub.res.write(ping);
        } catch {
          this.globalSubscribers.delete(sub);
        }
      }
    }, this.heartbeatInterval);
  }

  /**
   * Stop the heartbeat interval.
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Clean shutdown: stop heartbeat, clear all timers, close all connections, clear state.
   */
  destroy(): void {
    this.stopHeartbeat();

    // Clear all cleanup timers
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();

    // Close all per-job subscribers
    for (const [, jobSubs] of this.subscribers) {
      for (const res of jobSubs) {
        try {
          res.end();
        } catch {
          // Already closed
        }
      }
    }
    this.subscribers.clear();

    // Close all global subscribers
    for (const sub of this.globalSubscribers) {
      try {
        sub.res.end();
      } catch {
        // Already closed
      }
    }
    this.globalSubscribers.clear();

    // Clear buffers and counters
    this.buffers.clear();
    this.counters.clear();
  }

  /**
   * Replay events from a specific job's buffer after a given counter value,
   * applying filter matching. Returns true if the connection died during replay.
   */
  private async replayJobBuffer(
    jobId: string,
    afterCounter: number,
    res: ServerResponse,
    sub: GlobalSubscriber,
    filters: EventFilters,
    hasFilters: boolean,
  ): Promise<boolean> {
    const buffer = this.buffers.get(jobId);
    if (!buffer) return false;

    const events = buffer.getAfterIndex(afterCounter - 1);
    return this.replayEventsFiltered(jobId, events, res, sub, filters, hasFilters);
  }

  /**
   * Send a list of events to a global subscriber, applying filter matching.
   * Returns true if the connection died during replay (subscriber was removed).
   */
  private async replayEventsFiltered(
    jobId: string,
    events: JobEvent[],
    res: ServerResponse,
    sub: GlobalSubscriber,
    filters: EventFilters,
    hasFilters: boolean,
  ): Promise<boolean> {
    if (events.length === 0) return false;

    // Check filters if applicable
    if (hasFilters) {
      const job = await this.jobQueue.getJob(jobId);
      if (!this.matchesFilters(filters, job)) return false;
    }

    for (const event of events) {
      try {
        res.write(formatSSE(event));
      } catch {
        this.globalSubscribers.delete(sub);
        return true;
      }
    }
    return false;
  }

  /**
   * Check whether any global subscriber has at least one filter set.
   * Used to skip the async job lookup when no filters are active.
   */
  private anySubscriberHasFilters(): boolean {
    for (const sub of this.globalSubscribers) {
      const f = sub.filters;
      if (
        (f.tags && f.tags.length > 0) ||
        f.workflow !== undefined ||
        (f.status && f.status.length > 0)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Evaluate whether a job matches a subscriber's filters.
   *
   * All specified filters combine with AND logic:
   * - `tags`: job must have at least one matching tag
   * - `workflow`: job's workflow must match (string comparison)
   * - `status`: job's current status must be in the filter list
   *
   * If no filters are set (all fields undefined/empty), the event always matches.
   * If the job is null (not found), events are skipped for subscribers with filters.
   */
  private matchesFilters(
    filters: EventFilters,
    job: Job | null,
  ): boolean {
    const hasTagsFilter = filters.tags !== undefined && filters.tags.length > 0;
    const hasWorkflowFilter = filters.workflow !== undefined;
    const hasStatusFilter = filters.status !== undefined && filters.status.length > 0;

    // No filters → always matches
    if (!hasTagsFilter && !hasWorkflowFilter && !hasStatusFilter) {
      return true;
    }

    // Filters are set but job not found → no match
    if (!job) {
      return false;
    }

    // Tags filter: job must have at least one matching tag
    if (hasTagsFilter) {
      const jobTags = job.tags ?? [];
      const hasMatch = filters.tags!.some((tag) => jobTags.includes(tag));
      if (!hasMatch) return false;
    }

    // Workflow filter: job's workflow must match (string comparison)
    if (hasWorkflowFilter) {
      const jobWorkflow =
        typeof job.workflow === 'string' ? job.workflow : JSON.stringify(job.workflow);
      if (jobWorkflow !== filters.workflow) return false;
    }

    // Status filter: job's current status must be in the filter list
    if (hasStatusFilter) {
      if (!filters.status!.includes(job.status)) return false;
    }

    return true;
  }

  /**
   * Internal helper to remove a ServerResponse from all subscriber sets.
   */
  private removeSubscriber(res: ServerResponse): void {
    // Remove from per-job subscriber sets
    for (const [, jobSubs] of this.subscribers) {
      jobSubs.delete(res);
    }

    // Remove from global subscribers
    for (const sub of this.globalSubscribers) {
      if (sub.res === res) {
        this.globalSubscribers.delete(sub);
        break;
      }
    }
  }
}
