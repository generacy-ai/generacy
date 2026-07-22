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

export const DEFAULT_ANSWERS_FILE_PATH = '/workspaces/.generacy/cockpit/answers.ndjson';
export const DEFAULT_REPLAY_LINE_CAP = 10_000;
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
  watch?(path: string, opts?: { recursive?: boolean }): AsyncIterable<FsWatchEvent>;
}

export interface AnswersFileSourceLogger {
  warn(msg: string): void;
  info?(msg: string): void;
}

export interface AnswersFileSourceOptions {
  /** Bound epic ref in "owner/repo#number" form. Used to filter GateAnswerLine.scope. */
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
): AsyncIterable<FsWatchEvent> {
  const iter = nodeFsPromises.watch(p) as unknown as AsyncIterable<FsWatchEvent>;
  return iter;
}

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

function stringifyScope(scope: unknown): string {
  if (scope != null && typeof scope === 'object') {
    const rec = scope as Record<string, unknown>;
    if (
      typeof rec.owner === 'string' &&
      typeof rec.repo === 'string' &&
      typeof rec.number === 'number'
    ) {
      return `${rec.owner}/${rec.repo}#${rec.number}`;
    }
  }
  try {
    return JSON.stringify(scope);
  } catch {
    return String(scope);
  }
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

  private mode: TailerMode = 'waiting-for-dir';
  private running = false;
  private lastKnownIno: number | null = null;
  private lastKnownSize = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fsWatchIterator: AsyncIterator<FsWatchEvent> | null = null;
  private fsWatchLoop: Promise<void> | null = null;
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
    this.fs = options.fs ?? {
      stat: nodeStat,
      open: nodeOpen,
      watch: nodeWatch,
    };
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
      await this.doReplay(fileStat.ino);
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
    let iterable: AsyncIterable<FsWatchEvent>;
    try {
      iterable = this.fs.watch(this.parentDir);
    } catch {
      return;
    }
    const iter = iterable[Symbol.asyncIterator]();
    this.fsWatchIterator = iter;
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
            await this.processLine(lineBuf.toString('utf-8'), byteOffset);
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
          await this.processLine(lineBuf.toString('utf-8'), byteOffset);
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

  private async processLine(line: string, byteOffset: number): Promise<void> {
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

    // (c) Epic scope filter
    if (
      gateLine.scope.owner !== this.epicScope.owner ||
      gateLine.scope.repo !== this.epicScope.repo ||
      gateLine.scope.number !== this.epicScope.number
    ) {
      this.logger.info?.(
        `cockpit doorbell: answers file: cross-epic drop file=${this.filePath} byteOffset=${byteOffset} gateId=${gateLine.gateId} scope=${stringifyScope(gateLine.scope)} boundEpic=${this.epicRef}`,
      );
      return;
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
