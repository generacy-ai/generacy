/**
 * In-process event bus for `cockpit_await_events`.
 *
 * Per-epic broadcaster subscribed to the same event source `cockpit watch`
 * uses (poll loop + aggregate emits). Monotonic cursor; LRU buffer bounded
 * by `retentionCount` AND `retentionMs` (whichever hits first).
 *
 * Cursor is base64-encoded JSON `{epic, position, pnonce, bnonce}` — opaque
 * to callers. `pnonce` is a per-process instance nonce (16 hex chars);
 * `bnonce` is a per-bus-instance nonce (16 hex chars). Distinct classes:
 *   - `valid`         → normal path
 *   - `expired`       → position below the low-watermark; return `resetFrom: "expired"`
 *   - `discarded`     → nonce missing (legacy) or mismatched (cross-instance / evicted);
 *                       reset to head with `resetFrom: "discarded"`
 *   - `malformed`     → not base64 / not JSON / bad shape
 *   - `never-issued`  → shape ok, nonces match, but position outside issued range
 *   - `wrong-epic`    → cursor was issued for a different epic
 *
 * Retention env knobs: `COCKPIT_MCP_EVENT_RETENTION_COUNT` (default 10_000),
 * `COCKPIT_MCP_EVENT_RETENTION_MS` (default 600_000).
 */
import crypto from 'node:crypto';
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
  | { kind: 'discarded'; reason: 'legacy' | 'cross-instance' | 'evicted' }
  | { kind: 'malformed' }
  | { kind: 'never-issued' }
  | { kind: 'wrong-epic'; requestedEpic: string; boundEpic: string };

export interface EpicEventBusOptions {
  epic: string;
  retentionCount?: number;
  retentionMs?: number;
  now?: () => number;
  /** Test seam: override the per-bus nonce. Defaults to a fresh random. */
  nonce?: string;
}

interface Waiter {
  sinceCursor: number;
  resolve: (entries: EventBusEntry[]) => void;
}

/**
 * Per-process nonce generated once at module load. Embedded in every cursor
 * token so cross-instance cursors (server restart) classify as `discarded`
 * rather than `never-issued`.
 */
export const INSTANCE_NONCE: string = crypto.randomBytes(8).toString('hex');

/**
 * Shared default horizon (ms) for BOTH the in-memory buffer retention window
 * AND the registry's idle-TTL for refcount-0 buses. Any change here changes
 * both call sites in lockstep — FR-003.
 */
export const DEFAULT_QUIET_HORIZON_MS = 7_200_000;

const NONCE_SHAPE = /^[0-9a-f]{16}$/;

export function encodeCursor(
  epic: string,
  position: number,
  pnonce: string,
  bnonce: string,
): string {
  const json = JSON.stringify({ epic, position, pnonce, bnonce });
  return Buffer.from(json, 'utf-8').toString('base64');
}

export function decodeCursor(
  str: string,
): { epic: string; position: number; pnonce?: string; bnonce?: string } | null {
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
  const out: { epic: string; position: number; pnonce?: string; bnonce?: string } = {
    epic: record.epic,
    position: record.position,
  };
  if (typeof record.pnonce === 'string' && NONCE_SHAPE.test(record.pnonce)) {
    out.pnonce = record.pnonce;
  }
  if (typeof record.bnonce === 'string' && NONCE_SHAPE.test(record.bnonce)) {
    out.bnonce = record.bnonce;
  }
  return out;
}

export class EpicEventBus {
  readonly epic: string;
  readonly busNonce: string;
  private buffer: EventBusEntry[] = [];
  private nextCursor = 1;
  private waiters: Waiter[] = [];
  private readonly retentionCount: number;
  private readonly retentionMs: number;
  private readonly clock: () => number;

  constructor(options: EpicEventBusOptions) {
    this.epic = options.epic;
    this.retentionCount = options.retentionCount ?? 10_000;
    this.retentionMs = options.retentionMs ?? DEFAULT_QUIET_HORIZON_MS;
    this.clock = options.now ?? Date.now;
    this.busNonce = options.nonce ?? crypto.randomBytes(8).toString('hex');
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
    if (decoded.pnonce == null || decoded.bnonce == null) {
      return { kind: 'discarded', reason: 'legacy' };
    }
    if (decoded.epic !== this.epic) {
      return { kind: 'wrong-epic', requestedEpic: decoded.epic, boundEpic: this.epic };
    }
    if (decoded.pnonce !== INSTANCE_NONCE) {
      return { kind: 'discarded', reason: 'cross-instance' };
    }
    if (decoded.bnonce !== this.busNonce) {
      return { kind: 'discarded', reason: 'evicted' };
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
