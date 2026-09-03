/**
 * `AnswersFileSource` — tails `/workspaces/.generacy/cockpit/answers.ndjson`
 * (or a caller-supplied path) and emits validated `GateAnswerEvent`s onto a
 * caller-supplied sink. Peer of `SmeeDoorbellSource` — same DI shape, same
 * lifecycle, same log seam.
 *
 * Contract: `specs/1023-part-cockpit-remote-gates/contracts/answers-file-source.md`.
 */
import { promises as nodeFsPromises } from 'node:fs';
import path from 'node:path';
import {
  GateAnswerLineSchema,
  type GateAnswerEvent,
  type GateAnswerLine,
} from '../watch/gate-answer.js';
import { AnswersCursorStore } from './answers-cursor-store.js';
import type { EpicRefSetHolder } from './ref-set-holder.js';

export const DEFAULT_ANSWERS_FILE_PATH = '/workspaces/.generacy/cockpit/answers.ndjson';
export const DEFAULT_REPLAY_LINE_CAP = 10_000;
/** Recency window for replay branches: drop answers older than 24 h. */
export const DEFAULT_REPLAY_WINDOW_MS = 86_400_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 100;
const READ_CHUNK_SIZE = 64 * 1024;
const NEWLINE_BYTE = 0x0a;
const EPIC_REF_REGEX = /^[^/]+\/[^/]+#\d+$/;

export interface FsStatResult {
  ino: number;
  size: number;
}

export interface FsReadResult {
  bytesRead: number;
}

export interface FsFileHandle {
  read(buf: Buffer, off: number, len: number, pos: number): Promise<FsReadResult>;
  close(): Promise<void>;
}

export interface FsWatchEvent {
  eventType: string;
  filename: string | null;
}

export interface FsFacade {
  stat(path: string): Promise<FsStatResult>;
  open(path: string, flags: string): Promise<FsFileHandle>;
  watch?(
    path: string,
    opts?: { recursive?: boolean; signal?: AbortSignal },
  ): AsyncIterable<FsWatchEvent>;
  // Optional write surface used only by AnswersCursorStore. Kept optional so
  // existing read-only fake-fs test doubles remain valid; a store constructed
  // over a façade lacking these treats reads as missing and writes as no-ops.
  mkdir?(path: string, opts: { recursive: boolean }): Promise<void>;
  readFile?(path: string): Promise<string>;
  writeFile?(path: string, data: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
}

export interface AnswersFileSourceLogger {
  warn(msg: string): void;
  info?(msg: string): void;
}

export interface AnswersFileSourceOptions {
  /**
   * Bound epic ref in "owner/repo#number" form. With a `refSetHolder`, answers
   * are scoped by membership in the epic's resolved ref set (epic + children,
   * cross-repo included). Without one (harness mode), the legacy
   * case-insensitive owner/repo compare against this epic applies.
   */
  epicRef: string;
  /** Absolute path to the answers NDJSON file. */
  filePath?: string;
  /** Sink for validated, in-scope gate-answer events. */
  onEvent: (event: GateAnswerEvent) => Promise<void>;
  /** Log seam. */
  logger: AnswersFileSourceLogger;
  /** Startup replay cap (line count). Infinity disables (test-only). */
  replayLineCap?: number;
  /** Fallback poll cadence when fs.watch misses events. Default 2000 ms. */
  pollIntervalMs?: number;
  /** Whether to use fs.watch as the primary notification path. Default true. */
  useFsWatch?: boolean;
  /** Test seam: clock injection. Default () => Date.now(). */
  now?: () => number;
  /** Test seam: fs promises façade. Default node:fs/promises. */
  fs?: FsFacade;
  /**
   * Shared scope oracle. Absent ⇒ legacy owner/repo compare (harness mode).
   */
  refSetHolder?: EpicRefSetHolder;
  /** Recency window for replay branches. Default 86_400_000 (24 h). */
  replayWindowMs?: number;
  /** Cursor persistence. Absent ⇒ derived from `filePath`; injectable for tests. */
  cursorStore?: AnswersCursorStore;
  /** Test seam: override the cursor directory when deriving a default store. */
  cursorDir?: string;
}

export type TailerMode =
  | 'waiting-for-dir'
  | 'waiting-for-file'
  | 'replaying'
  | 'tailing'
  | 'stopped';

interface EpicScope {
  owner: string;
  repo: string;
  number: number;
}

function parseEpicRef(epicRef: string): EpicScope {
  const match = epicRef.match(/^([^/]+)\/([^/]+)#(\d+)$/);
  if (match == null) {
    throw new Error(`AnswersFileSource: invalid epicRef "${epicRef}"`);
  }
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]!),
  };
}

function nodeStat(p: string): Promise<FsStatResult> {
  return nodeFsPromises.stat(p).then((s) => ({
    ino: Number(s.ino),
    size: s.size,
  }));
}

async function nodeOpen(p: string, flags: string): Promise<FsFileHandle> {
  const handle = await nodeFsPromises.open(p, flags);
  return {
    read: async (buf, off, len, pos) => {
      const r = await handle.read(buf, off, len, pos);
      return { bytesRead: r.bytesRead };
    },
    close: () => handle.close(),
  };
}

function nodeWatch(
  p: string,
  opts?: { recursive?: boolean; signal?: AbortSignal },
): AsyncIterable<FsWatchEvent> {
  const iter = nodeFsPromises.watch(p, opts) as unknown as AsyncIterable<FsWatchEvent>;
  return iter;
}

/**
 * Production `FsFacade` — the single default used by `doorbell.ts` and the
 * AnswersCursorStore it wires. Read surface (stat/open/watch) plus the write
 * surface (mkdir/readFile/writeFile/rename) the cursor store needs.
 */
export const nodeFsFacade: FsFacade = {
  stat: nodeStat,
  open: nodeOpen,
  watch: nodeWatch,
  mkdir: async (p, opts) => {
    await nodeFsPromises.mkdir(p, opts);
  },
  readFile: (p) => nodeFsPromises.readFile(p, 'utf-8'),
  writeFile: async (p, data) => {
    await nodeFsPromises.writeFile(p, data);
  },
  rename: (from, to) => nodeFsPromises.rename(from, to),
};

function isEnoent(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

/**
 * Best-effort extract a `gateId` from a raw NDJSON line so a malformed-line
 * warn can name the gate even when the surrounding shape failed schema
 * validation.
 */
function extractGateIdBestEffort(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed != null && typeof parsed === 'object' && 'gateId' in parsed) {
      const g = (parsed as { gateId?: unknown }).gateId;
      if (typeof g === 'string' && g.length > 0) return g;
    }
  } catch {
    /* not JSON — no gateId */
  }
  return undefined;
}

/**
 * Parse the issue-ref portion of a frozen gate-answer `gateKey`
 * (`<owner>/<repo>#<issue>:<gateType>:<generation>`) into owner/repo/number.
 * The issue-ref is the substring up to the FIRST `:` — `gateType` and
 * `generation` may themselves contain `:` (e.g. escalation
 * `subtype:state:occurrence`), but the issue-ref never does. Returns null for a
 * non-issue target (filing / scope-drained may key on a tracking ref that is
 * not an `owner/repo#N` issue); such lines skip the scope filter and are
 * emitted (downstream keys on gateId).
 */
function parseIssueRefFromGateKey(
  gateKey: string,
): { owner: string; repo: string; number: number } | null {
  const issueRef = gateKey.split(':', 1)[0] ?? '';
  const m = issueRef.match(/^([^/]+)\/([^/]+)#(\d+)$/);
  if (m == null) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]!) };
}

export class AnswersFileSource {
  private readonly epicRef: string;
  private readonly epicScope: EpicScope;
  private readonly filePath: string;
  private readonly parentDir: string;
  private readonly onEvent: (event: GateAnswerEvent) => Promise<void>;
  private readonly logger: AnswersFileSourceLogger;
  private readonly replayLineCap: number;
  private readonly pollIntervalMs: number;
  private readonly useFsWatch: boolean;
  private readonly now: () => number;
  private readonly fs: FsFacade;
  private readonly holder: EpicRefSetHolder | null;
  private readonly replayWindowMs: number;
  private readonly cursorStore: AnswersCursorStore;

  private mode: TailerMode = 'waiting-for-dir';
  private running = false;
  private lastKnownIno: number | null = null;
  private lastKnownSize = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fsWatchIterator: AsyncIterator<FsWatchEvent> | null = null;
  private fsWatchLoop: Promise<void> | null = null;
  private fsWatchAbort: AbortController | null = null;
  private tickInFlight = false;
  private pendingTick = false;

  constructor(options: AnswersFileSourceOptions) {
    if (!EPIC_REF_REGEX.test(options.epicRef)) {
      throw new Error(
        `AnswersFileSource: epicRef "${options.epicRef}" must match owner/repo#number`,
      );
    }
    const cap = options.replayLineCap ?? DEFAULT_REPLAY_LINE_CAP;
    if (!(cap > 0 || cap === Infinity)) {
      throw new Error(
        `AnswersFileSource: replayLineCap must be > 0 or Infinity (got ${cap})`,
      );
    }
    const poll = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!(poll >= MIN_POLL_INTERVAL_MS)) {
      throw new Error(
        `AnswersFileSource: pollIntervalMs must be >= ${MIN_POLL_INTERVAL_MS} (got ${poll})`,
      );
    }

    this.epicRef = options.epicRef;
    this.epicScope = parseEpicRef(options.epicRef);
    this.filePath = options.filePath ?? DEFAULT_ANSWERS_FILE_PATH;
    this.parentDir = path.dirname(this.filePath);
    this.onEvent = options.onEvent;
    this.logger = options.logger;
    this.replayLineCap = cap;
    this.pollIntervalMs = poll;
    this.useFsWatch = options.useFsWatch ?? true;
    this.now = options.now ?? (() => Date.now());
    this.fs = options.fs ?? nodeFsFacade;
    this.holder = options.refSetHolder ?? null;
    this.replayWindowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.cursorStore =
      options.cursorStore ??
      new AnswersCursorStore({
        answersFilePath: this.filePath,
        epicRef: this.epicRef,
        logger: this.logger,
        fs: this.fs,
        now: this.now,
        ...(options.cursorDir != null ? { cursorDir: options.cursorDir } : {}),
      });
  }

  getState(): TailerMode {
    return this.mode;
  }

  async start(): Promise<void> {
    if (this.running || this.mode === 'stopped') return;
    this.running = true;
    this.pollTimer = setInterval(() => {
      this.scheduleTick();
    }, this.pollIntervalMs);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    await this.runTick();
  }

  async stop(): Promise<void> {
    if (this.mode === 'stopped' && !this.running) return;
    this.running = false;
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.stopFsWatch();
    // Persist the final consumed position so a restart resumes cleanly.
    await this.cursorStore.flush();
    this.mode = 'stopped';
  }

  private scheduleTick(): void {
    if (!this.running) return;
    if (this.tickInFlight) {
      this.pendingTick = true;
      return;
    }
    void this.runTick();
  }

  private async runTick(): Promise<void> {
    if (this.tickInFlight) {
      this.pendingTick = true;
      return;
    }
    this.tickInFlight = true;
    try {
      do {
        this.pendingTick = false;
        if (!this.running) return;
        await this.tickOnce();
      } while (this.pendingTick && this.running);
    } finally {
      this.tickInFlight = false;
    }
  }

  private async tickOnce(): Promise<void> {
    let parentExists: boolean;
    try {
      await this.fs.stat(this.parentDir);
      parentExists = true;
    } catch (err) {
      if (isEnoent(err)) {
        parentExists = false;
      } else {
        this.logger.warn(
          `cockpit doorbell: answers file: stat parent dir failed dir=${this.parentDir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    }

    if (!parentExists) {
      if (this.mode !== 'waiting-for-dir') {
        this.mode = 'waiting-for-dir';
        // Retain lastKnownIno/lastKnownSize — on re-appearance the ino
        // comparison will surface as a rotation (which is what the
        // dir-was-removed-then-recreated case actually looks like on disk).
        await this.stopFsWatch();
        this.logger.info?.(
          `cockpit doorbell: answers file: waiting for parent dir dir=${this.parentDir}`,
        );
      }
      return;
    }

    if (this.useFsWatch && this.fsWatchIterator == null && this.fs.watch != null) {
      this.startFsWatchLoop();
    }

    let fileStat: FsStatResult;
    try {
      fileStat = await this.fs.stat(this.filePath);
    } catch (err) {
      if (isEnoent(err)) {
        if (this.mode !== 'waiting-for-file') {
          this.mode = 'waiting-for-file';
          // Retain lastKnownIno/lastKnownSize so re-appearance surfaces as a
          // rotation (contract §Lifecycle: file removed → waiting-for-file;
          // reappearance re-enters replaying).
          this.logger.info?.(
            `cockpit doorbell: answers file: waiting for file file=${this.filePath}`,
          );
        }
        return;
      }
      this.logger.warn(
        `cockpit doorbell: answers file: stat file failed file=${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // File exists.
    if (this.lastKnownIno == null) {
      // First-time discovery from waiting-for-dir / waiting-for-file.
      await this.doFirstDiscovery(fileStat);
      return;
    }

    if (fileStat.ino !== this.lastKnownIno) {
      this.logger.info?.(
        `cockpit doorbell: answers file: rotation file=${this.filePath} oldIno=${this.lastKnownIno} newIno=${fileStat.ino}`,
      );
      await this.doReplay(fileStat.ino);
      return;
    }

    if (fileStat.size < this.lastKnownSize) {
      this.logger.info?.(
        `cockpit doorbell: answers file: truncation file=${this.filePath} ino=${fileStat.ino} oldSize=${this.lastKnownSize} newSize=${fileStat.size}`,
      );
      await this.doReplay(fileStat.ino);
      return;
    }

    if (fileStat.size > this.lastKnownSize) {
      await this.doTail(fileStat.size);
    }
  }

  private startFsWatchLoop(): void {
    if (this.fs.watch == null) return;
    // Wire an AbortSignal so teardown is deterministic: a Node
    // `fsPromises.watch` async iterator never settles its pending `next()` (nor
    // `return()`) without a filesystem event, so `stopFsWatch()` would hang
    // forever unless the watcher is cancellable. Aborting the signal ends the
    // iterator, which lets both awaits in `stopFsWatch()` resolve.
    const controller = new AbortController();
    let iterable: AsyncIterable<FsWatchEvent>;
    try {
      iterable = this.fs.watch(this.parentDir, { signal: controller.signal });
    } catch {
      return;
    }
    const iter = iterable[Symbol.asyncIterator]();
    this.fsWatchIterator = iter;
    this.fsWatchAbort = controller;
    this.fsWatchLoop = (async (): Promise<void> => {
      try {
        while (this.running) {
          const step = await iter.next();
          if (step.done === true) break;
          if (!this.running) break;
          this.scheduleTick();
        }
      } catch {
        /* watch iterator errored — poll handles it */
      }
    })();
  }

  private async stopFsWatch(): Promise<void> {
    if (this.fsWatchIterator == null) return;
    const iter = this.fsWatchIterator;
    this.fsWatchIterator = null;
    // Cancel the underlying watcher first so the pending `next()` in
    // `fsWatchLoop` settles and `return()` can resolve.
    this.fsWatchAbort?.abort();
    this.fsWatchAbort = null;
    try {
      await iter.return?.(undefined);
    } catch {
      /* ignore */
    }
    if (this.fsWatchLoop != null) {
      try {
        await this.fsWatchLoop;
      } catch {
        /* ignore */
      }
      this.fsWatchLoop = null;
    }
  }

  /**
   * First discovery of the answers file. Consult the persisted cursor: a valid
   * cursor for this exact inode whose offset lies within the current size lets
   * us RESUME from `offset` with no replay and no recency window (only bytes the
   * running doorbell never consumed are tailed). Any other state (missing/stale
   * cursor, wrong ino, offset past EOF) falls back to a fresh byte-0 replay,
   * which is window- and scope-bounded.
   */
  private async doFirstDiscovery(fileStat: FsStatResult): Promise<void> {
    const cursor = await this.cursorStore.load();
    if (!this.running) return;
    if (
      cursor != null &&
      cursor.ino === fileStat.ino &&
      cursor.offset <= fileStat.size
    ) {
      // Resume: adopt the cursor as the consumed high-water mark and tail only
      // the unconsumed tail (if any) with no replay/window.
      this.lastKnownIno = fileStat.ino;
      this.lastKnownSize = cursor.offset;
      this.mode = 'tailing';
      if (fileStat.size > cursor.offset) {
        await this.doTail(fileStat.size);
      }
      return;
    }
    await this.doReplay(fileStat.ino);
  }

  private async doReplay(ino: number): Promise<void> {
    this.mode = 'replaying';
    this.lastKnownIno = ino;
    this.lastKnownSize = 0;

    let totalLines = 0;
    if (this.replayLineCap !== Infinity) {
      totalLines = await this.countLines();
      if (!this.running) return;
    }
    const skipFirst =
      this.replayLineCap === Infinity
        ? 0
        : Math.max(0, totalLines - this.replayLineCap);

    const { nextConsumedByte, lastSkippedEndByte } = await this.emitFromHead(
      skipFirst,
    );
    if (skipFirst > 0) {
      const skippedTo = lastSkippedEndByte ?? 0;
      this.logger.warn(
        `cockpit doorbell: answers file: replay cap hit file=${this.filePath} skippedLines=${skipFirst} skippedFromByte=0 skippedToByte=${skippedTo}`,
      );
    }
    this.lastKnownSize = nextConsumedByte;
    // Force-persist the consumed position at replay drain so a restart resumes
    // from here instead of replaying the whole window again.
    await this.cursorStore.flush();
    if (this.running) {
      this.mode = 'tailing';
    }
  }

  private async doTail(newSize: number): Promise<void> {
    if (newSize <= this.lastKnownSize) return;
    const { nextConsumedByte } = await this.readAndEmitRange(
      this.lastKnownSize,
      newSize,
    );
    this.lastKnownSize = nextConsumedByte;
  }

  /**
   * Advance the persisted cursor to `lineEndByte` for the current inode after a
   * line has been fully processed (emitted, or dropped by window/scope/schema).
   * The store debounces the write and is monotonic within an inode.
   */
  private advanceCursor(lineEndByte: number): void {
    if (this.lastKnownIno == null) return;
    this.cursorStore.advance(this.lastKnownIno, lineEndByte);
  }

  private async countLines(): Promise<number> {
    const handle = await this.fs.open(this.filePath, 'r');
    let count = 0;
    try {
      const buf = Buffer.alloc(READ_CHUNK_SIZE);
      let pos = 0;
      while (this.running) {
        const { bytesRead } = await handle.read(buf, 0, READ_CHUNK_SIZE, pos);
        if (bytesRead === 0) break;
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === NEWLINE_BYTE) count++;
        }
        pos += bytesRead;
      }
    } finally {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    return count;
  }

  private async emitFromHead(
    skipFirst: number,
  ): Promise<{ nextConsumedByte: number; lastSkippedEndByte: number | null }> {
    const handle = await this.fs.open(this.filePath, 'r');
    const chunk = Buffer.alloc(READ_CHUNK_SIZE);
    let filePos = 0;
    let leftover: Buffer = Buffer.alloc(0);
    let leftoverStartByte = 0;
    let lineIndex = 0;
    let lastSkippedEndByte: number | null = null;
    try {
      while (this.running) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          READ_CHUNK_SIZE,
          filePos,
        );
        if (bytesRead === 0) break;
        const combined =
          leftover.length === 0
            ? chunk.subarray(0, bytesRead)
            : Buffer.concat(
                [leftover, chunk.subarray(0, bytesRead)],
                leftover.length + bytesRead,
              );
        let searchFrom = 0;
        while (this.running) {
          const idx = combined.indexOf(NEWLINE_BYTE, searchFrom);
          if (idx === -1) break;
          const lineBuf = combined.subarray(searchFrom, idx);
          const byteOffset = leftoverStartByte + searchFrom;
          const lineEndByte = byteOffset + lineBuf.length + 1;
          if (lineIndex < skipFirst) {
            lastSkippedEndByte = lineEndByte;
          } else {
            await this.processLine(lineBuf.toString('utf-8'), byteOffset, true);
            this.advanceCursor(lineEndByte);
            if (!this.running) {
              return {
                nextConsumedByte: lineEndByte,
                lastSkippedEndByte,
              };
            }
          }
          lineIndex++;
          searchFrom = idx + 1;
        }
        if (!this.running) break;
        leftover = Buffer.from(combined.subarray(searchFrom));
        leftoverStartByte = leftoverStartByte + searchFrom;
        filePos += bytesRead;
      }
      return {
        nextConsumedByte: leftoverStartByte,
        lastSkippedEndByte,
      };
    } finally {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }

  private async readAndEmitRange(
    fromByte: number,
    toByte: number,
  ): Promise<{ nextConsumedByte: number }> {
    const handle = await this.fs.open(this.filePath, 'r');
    const chunk = Buffer.alloc(READ_CHUNK_SIZE);
    let filePos = fromByte;
    let leftover: Buffer = Buffer.alloc(0);
    let leftoverStartByte = fromByte;
    try {
      while (this.running && filePos < toByte) {
        const remaining = toByte - filePos;
        const requested = Math.min(READ_CHUNK_SIZE, remaining);
        const { bytesRead } = await handle.read(
          chunk,
          0,
          requested,
          filePos,
        );
        if (bytesRead === 0) break;
        const combined =
          leftover.length === 0
            ? chunk.subarray(0, bytesRead)
            : Buffer.concat(
                [leftover, chunk.subarray(0, bytesRead)],
                leftover.length + bytesRead,
              );
        let searchFrom = 0;
        while (this.running) {
          const idx = combined.indexOf(NEWLINE_BYTE, searchFrom);
          if (idx === -1) break;
          const lineBuf = combined.subarray(searchFrom, idx);
          const byteOffset = leftoverStartByte + searchFrom;
          const lineEndByte = byteOffset + lineBuf.length + 1;
          await this.processLine(lineBuf.toString('utf-8'), byteOffset, false);
          this.advanceCursor(lineEndByte);
          if (!this.running) {
            return { nextConsumedByte: lineEndByte };
          }
          searchFrom = idx + 1;
        }
        if (!this.running) break;
        leftover = Buffer.from(combined.subarray(searchFrom));
        leftoverStartByte = leftoverStartByte + searchFrom;
        filePos += bytesRead;
      }
      return { nextConsumedByte: leftoverStartByte };
    } finally {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }

  private async processLine(
    line: string,
    byteOffset: number,
    applyWindow: boolean,
  ): Promise<void> {
    if (!this.running) return;

    // (a) JSON.parse
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      const gateId = extractGateIdBestEffort(line);
      const gateSuffix = gateId != null ? ` gateId=${gateId}` : '';
      this.logger.warn(
        `cockpit doorbell: answers file: malformed line (not JSON) file=${this.filePath} byteOffset=${byteOffset}${gateSuffix}`,
      );
      return;
    }

    // (b) Schema validation
    const parsed = GateAnswerLineSchema.safeParse(raw);
    if (!parsed.success) {
      const gateId = extractGateIdBestEffort(line);
      const gateSuffix = gateId != null ? ` gateId=${gateId}` : '';
      this.logger.warn(
        `cockpit doorbell: answers file: malformed line (schema) file=${this.filePath} byteOffset=${byteOffset}${gateSuffix}`,
      );
      return;
    }
    const gateLine: GateAnswerLine = parsed.data;

    // (c′) Recency window (replay branches only). Drop answers older than the
    // window so a fresh byte-0 replay never re-fires ancient gates. Evaluated
    // BEFORE the scope test so an out-of-window line never triggers a miss
    // refresh. Never applied to resumed-cursor tailing (applyWindow=false); an
    // unparseable answeredAt is kept (fail-open — schema already validated it as
    // a datetime, so this is defensive).
    if (applyWindow) {
      const answeredMs = Date.parse(gateLine.answeredAt);
      if (Number.isFinite(answeredMs) && answeredMs < this.now() - this.replayWindowMs) {
        this.logger.info?.(
          `cockpit doorbell: answers file: window drop file=${this.filePath} byteOffset=${byteOffset} gateId=${gateLine.gateId} answeredAt=${gateLine.answeredAt}`,
        );
        return;
      }
    }

    // (c″) Scope filter. The frozen down-path gate-answer carries no `scope`;
    // the owner/repo/number is parsed out of the answer's `gateKey` issue-ref.
    // A gateKey whose issue-ref cannot be parsed (a non-issue filing /
    // scope-drained target) bypasses scoping and is emitted; downstream matches
    // on gateId. With a ref-set holder, membership is tested against the bound
    // epic's resolved ref set (epic + children, cross-repo included) keyed
    // `owner/repo#number` lowercased; on a miss we re-resolve (throttled) and
    // re-check before dropping, so a late-created child is not lost. Without a
    // holder (harness mode), the legacy case-insensitive owner/repo compare
    // against the bound epic applies.
    const gateScope = parseIssueRefFromGateKey(gateLine.gateKey);
    if (gateScope != null) {
      if (this.holder != null) {
        const key = `${gateScope.owner.toLowerCase()}/${gateScope.repo.toLowerCase()}#${gateScope.number}`;
        let inScope = this.holder.current?.issues.has(key) ?? false;
        if (!inScope) {
          await this.holder.refreshOnMiss();
          if (!this.running) return;
          inScope = this.holder.current?.issues.has(key) ?? false;
        }
        if (!inScope) {
          this.logger.info?.(
            `cockpit doorbell: answers file: cross-epic drop file=${this.filePath} byteOffset=${byteOffset} gateId=${gateLine.gateId} scope=${gateScope.owner}/${gateScope.repo}#${gateScope.number} boundEpic=${this.epicRef}`,
          );
          return;
        }
      } else if (
        gateScope.owner.toLowerCase() !== this.epicScope.owner.toLowerCase() ||
        gateScope.repo.toLowerCase() !== this.epicScope.repo.toLowerCase()
      ) {
        this.logger.info?.(
          `cockpit doorbell: answers file: cross-epic drop file=${this.filePath} byteOffset=${byteOffset} gateId=${gateLine.gateId} scope=${gateScope.owner}/${gateScope.repo}#${gateScope.number} boundEpic=${this.epicRef}`,
        );
        return;
      }
    }

    // (d) Build event
    const event: GateAnswerEvent = {
      type: 'gate-answer',
      ts: new Date(this.now()).toISOString(),
      gateId: gateLine.gateId,
      deliveryId: gateLine.deliveryId,
      epic: this.epicRef,
      line: gateLine,
    };

    // (e) Emit
    if (!this.running) return;
    try {
      await this.onEvent(event);
    } catch (err) {
      this.logger.warn(
        `cockpit doorbell: answers file: onEvent sink rejected file=${this.filePath} byteOffset=${byteOffset} gateId=${gateLine.gateId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
