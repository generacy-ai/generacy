/**
 * `AnswersCursorStore` — persists the answers-file consumed position
 * (`ino` + byte `offset`) per epic scope so a doorbell restart resumes from the
 * last consumed byte instead of replaying from byte 0.
 *
 * Contract: `specs/1228-symptom-every-generacy-cockpit/contracts/answers-cursor-store.md`.
 */
import path from 'node:path';
import { z } from 'zod';
import type { FsFacade } from './answers-file-source.js';

export const AnswersCursorSchema = z.object({
  version: z.literal(1),
  /** inode of the answers file the offset indexes. */
  ino: z.number().int().nonnegative(),
  /** Next unconsumed byte (end byte of the last processed line, incl. newline). */
  offset: z.number().int().nonnegative(),
  /** Diagnostic only — never used for staleness decisions. */
  updatedAt: z.string().datetime(),
});
export type AnswersCursor = z.infer<typeof AnswersCursorSchema>;

export const DEFAULT_FLUSH_DEBOUNCE_MS = 500;

export interface AnswersCursorStoreOptions {
  /** Absolute path to the answers file; cursor dir derives from `dirname()`. */
  answersFilePath: string;
  /** Bound epic ref "owner/repo#N" → filename `<owner>__<repo>__<n>.json`. */
  epicRef: string;
  logger: { warn(msg: string): void };
  /** Test seam: fs façade (shared with AnswersFileSource). */
  fs?: FsFacade;
  /**
   * Test seam: override the cursors directory. Defaults to
   * `<dirname(answersFilePath)>/cursors`.
   */
  cursorDir?: string;
  /** Debounce window for `advance()`-triggered persists. Default 500 ms. */
  flushDebounceMs?: number;
  /** Test seam: clock injection. Default () => Date.now(). */
  now?: () => number;
}

function cursorFileName(epicRef: string): string {
  const m = epicRef.match(/^([^/]+)\/([^/]+)#(\d+)$/);
  if (m == null) {
    throw new Error(`AnswersCursorStore: invalid epicRef "${epicRef}"`);
  }
  const owner = m[1]!.toLowerCase();
  const repo = m[2]!.toLowerCase();
  const number = m[3]!;
  return `${owner}__${repo}__${number}.json`;
}

export class AnswersCursorStore {
  private readonly cursorsDir: string;
  private readonly cursorPath: string;
  private readonly logger: { warn(msg: string): void };
  private readonly fs: FsFacade | undefined;
  private readonly flushDebounceMs: number;
  private readonly now: () => number;

  private inMemory: { ino: number; offset: number } | null = null;
  private dirEnsured = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(options: AnswersCursorStoreOptions) {
    const answersDir = path.dirname(options.answersFilePath);
    this.cursorsDir = options.cursorDir ?? path.join(answersDir, 'cursors');
    this.cursorPath = path.join(this.cursorsDir, cursorFileName(options.epicRef));
    this.logger = options.logger;
    this.fs = options.fs;
    this.flushDebounceMs = options.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Read + validate the persisted cursor. Missing/corrupt/wrong-version ⇒ null.
   * Never throws.
   */
  async load(): Promise<{ ino: number; offset: number } | null> {
    if (this.fs?.readFile == null) return null;
    let raw: string;
    try {
      raw = await this.fs.readFile(this.cursorPath);
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const result = AnswersCursorSchema.safeParse(parsed);
    if (!result.success) return null;
    const cursor = { ino: result.data.ino, offset: result.data.offset };
    this.inMemory = cursor;
    return cursor;
  }

  /**
   * Update the in-memory cursor and schedule a debounced persist. Monotonic
   * within an ino (never lowers the offset); a new ino resets the offset.
   */
  advance(ino: number, offset: number): void {
    if (this.inMemory != null && this.inMemory.ino === ino) {
      if (offset <= this.inMemory.offset) return;
      this.inMemory = { ino, offset };
    } else {
      // New ino (or first advance) resets the tracked offset.
      this.inMemory = { ino, offset };
    }
    this.scheduleFlush();
  }

  /**
   * Unconditionally rewrite the in-memory cursor (bypassing `advance()`'s
   * monotonic-within-ino guard) and schedule a persist.
   *
   * Every replay branch restarts consumption from byte 0. Rotation is safe
   * under `advance()` because the inode changes, but an **in-place truncation**
   * keeps the SAME inode: without this reset the monotonic guard swallows every
   * advance below the pre-truncation high-water mark, `flush()` rewrites the
   * stale (too-high) offset over a now-tiny file, and the next start takes the
   * resume branch and skips every answer under that byte — permanently, with no
   * convergence. `contracts/answers-cursor-store.md` requires the
   * `cursor.offset > stat.size` (truncation) row to **rewrite** the cursor;
   * this is that rewrite.
   */
  reset(ino: number, offset: number): void {
    this.inMemory = { ino, offset };
    this.scheduleFlush();
  }

  /**
   * Force-persist the in-memory cursor now (atomic tmp+rename). Used at replay
   * drain and stop(). Failures are logged at warn, never thrown.
   */
  async flush(): Promise<void> {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Coalesce overlapping flushes onto a single in-flight write.
    if (this.flushInFlight != null) {
      await this.flushInFlight;
      return;
    }
    const p = this.doFlush();
    this.flushInFlight = p;
    try {
      await p;
    } finally {
      if (this.flushInFlight === p) this.flushInFlight = null;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer != null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDebounceMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  private async doFlush(): Promise<void> {
    const cursor = this.inMemory;
    if (cursor == null) return;
    if (
      this.fs?.writeFile == null ||
      this.fs.rename == null ||
      this.fs.mkdir == null
    ) {
      return;
    }
    const payload: AnswersCursor = {
      version: 1,
      ino: cursor.ino,
      offset: cursor.offset,
      updatedAt: new Date(this.now()).toISOString(),
    };
    try {
      if (!this.dirEnsured) {
        await this.fs.mkdir(this.cursorsDir, { recursive: true });
        this.dirEnsured = true;
      }
      const tmpPath = `${this.cursorPath}.tmp-${process.pid}-${this.now()}`;
      await this.fs.writeFile(tmpPath, JSON.stringify(payload));
      await this.fs.rename(tmpPath, this.cursorPath);
    } catch (err) {
      this.logger.warn(
        `cockpit doorbell: answers cursor: persist failed path=${this.cursorPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
