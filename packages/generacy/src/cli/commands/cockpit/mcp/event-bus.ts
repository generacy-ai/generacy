/**
 * In-process event bus for `cockpit_await_events`.
 *
 * Per-epic broadcaster subscribed to the same event source `cockpit watch`
 * uses (poll loop + aggregate emits). Monotonic cursor; LRU buffer bounded
 * by `retentionCount` AND `retentionMs` (whichever hits first).
 *
 * Cursor is base64-encoded JSON `{epic, position}` — opaque to callers.
 * Distinct cursor classes (Q3-D):
 *   - `valid`         → normal path
 *   - `expired`       → position below the low-watermark; return `resetFrom: "expired"`
 *   - `malformed`     → not base64 / not JSON / bad shape
 *   - `never-issued`  → shape ok but position outside issued range (0 or > next)
 *   - `wrong-epic`    → cursor was issued for a different epic
 *
 * Retention env knobs: `COCKPIT_MCP_EVENT_RETENTION_COUNT` (default 10_000),
 * `COCKPIT_MCP_EVENT_RETENTION_MS` (default 600_000).
 */
import type { CockpitStreamEvent } from '../watch/stream-event.js';

export interface EventBusEntry {
  cursor: number;
  event: CockpitStreamEvent;
  emittedAt: number;
}

export interface WaitForInput {
  sinceCursor: number;
  maxWaitMs: number;
  coalesceWindowMs: number;
  maxBatchSize: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

export interface WaitForResult {
  entries: EventBusEntry[];
  resetFrom?: 'expired';
}

export type CursorParseResult =
  | { kind: 'valid'; position: number }
  | { kind: 'expired'; requestedPosition: number }
  | { kind: 'malformed' }
  | { kind: 'never-issued' }
  | { kind: 'wrong-epic'; requestedEpic: string; boundEpic: string };

export interface EpicEventBusOptions {
  epic: string;
  retentionCount?: number;
  retentionMs?: number;
  now?: () => number;
}

interface Waiter {
  sinceCursor: number;
  resolve: (entries: EventBusEntry[]) => void;
}

export function encodeCursor(epic: string, position: number): string {
  const json = JSON.stringify({ epic, position });
  return Buffer.from(json, 'utf-8').toString('base64');
}

export function decodeCursor(str: string): { epic: string; position: number } | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(str, 'base64');
  } catch {
    return null;
  }
  const decoded = buf.toString('utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.epic !== 'string' || typeof record.position !== 'number') return null;
  if (!Number.isInteger(record.position) || record.position < 0) return null;
  return { epic: record.epic, position: record.position };
}

export class EpicEventBus {
  readonly epic: string;
  private buffer: EventBusEntry[] = [];
  private nextCursor = 1;
  private waiters: Waiter[] = [];
  private readonly retentionCount: number;
  private readonly retentionMs: number;
  private readonly clock: () => number;

  constructor(options: EpicEventBusOptions) {
    this.epic = options.epic;
    this.retentionCount = options.retentionCount ?? 10_000;
    this.retentionMs = options.retentionMs ?? 600_000;
    this.clock = options.now ?? Date.now;
  }

  emit(event: CockpitStreamEvent): EventBusEntry {
    const entry: EventBusEntry = {
      cursor: this.nextCursor,
      event,
      emittedAt: this.clock(),
    };
    this.nextCursor += 1;
    this.buffer.push(entry);
    this.trim();
    this.flushWaiters();
    return entry;
  }

  parseCursor(str: string | undefined): CursorParseResult {
    if (str == null) return { kind: 'valid', position: 0 };
    const decoded = decodeCursor(str);
    if (decoded == null) return { kind: 'malformed' };
    if (decoded.epic !== this.epic) {
      return { kind: 'wrong-epic', requestedEpic: decoded.epic, boundEpic: this.epic };
    }
    if (decoded.position === 0) return { kind: 'valid', position: 0 };
    if (decoded.position >= this.nextCursor) return { kind: 'never-issued' };
    const lowWatermark =
      this.buffer.length === 0 ? this.nextCursor : this.buffer[0]!.cursor;
    if (decoded.position < lowWatermark - 1) {
      return { kind: 'expired', requestedPosition: decoded.position };
    }
    return { kind: 'valid', position: decoded.position };
  }

  /**
   * Drain entries with cursor > sinceCursor immediately (up to maxBatchSize);
   * if empty, wait up to maxWaitMs for the first emit, then coalesce for
   * coalesceWindowMs (or until maxBatchSize is reached).
   */
  async waitFor(input: WaitForInput): Promise<WaitForResult> {
    const now = input.now ?? this.clock;

    const drainFrom = (since: number, cap: number): EventBusEntry[] => {
      const out: EventBusEntry[] = [];
      for (const entry of this.buffer) {
        if (entry.cursor <= since) continue;
        out.push(entry);
        if (out.length >= cap) break;
      }
      return out;
    };

    let batch = drainFrom(input.sinceCursor, input.maxBatchSize);
    if (batch.length === 0) {
      if (input.maxWaitMs === 0) {
        return { entries: [] };
      }
      const first = await this.waitForFirstEmit(input.sinceCursor, input.maxWaitMs);
      if (first == null) return { entries: [] };
      batch = [first];
    }

    if (batch.length >= input.maxBatchSize) {
      return { entries: batch };
    }

    if (input.coalesceWindowMs > 0) {
      const deadline = now() + input.coalesceWindowMs;
      while (batch.length < input.maxBatchSize) {
        const remaining = deadline - now();
        if (remaining <= 0) break;
        const nextSince = batch[batch.length - 1]!.cursor;
        const more = drainFrom(nextSince, input.maxBatchSize - batch.length);
        if (more.length > 0) {
          for (const entry of more) batch.push(entry);
          continue;
        }
        const next = await this.waitForFirstEmit(nextSince, remaining);
        if (next == null) break;
        batch.push(next);
      }
    }

    return { entries: batch };
  }

  private waitForFirstEmit(sinceCursor: number, waitMs: number): Promise<EventBusEntry | null> {
    return new Promise<EventBusEntry | null>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, waitMs);
      if (timer.unref) timer.unref();
      const waiter: Waiter = {
        sinceCursor,
        resolve: (entries) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(entries[0] ?? null);
        },
      };
      this.waiters.push(waiter);
    });
  }

  private flushWaiters(): void {
    if (this.waiters.length === 0) return;
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      const entries: EventBusEntry[] = [];
      for (const entry of this.buffer) {
        if (entry.cursor > waiter.sinceCursor) entries.push(entry);
      }
      waiter.resolve(entries);
    }
  }

  private trim(): void {
    const cutoff = this.clock() - this.retentionMs;
    while (this.buffer.length > 0 && this.buffer[0]!.emittedAt < cutoff) {
      this.buffer.shift();
    }
    while (this.buffer.length > this.retentionCount) {
      this.buffer.shift();
    }
  }

  /** Test-only inspector. */
  size(): number {
    return this.buffer.length;
  }
}
