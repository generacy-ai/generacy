import { promises as fs, existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface CockpitAnswersWriterOptions {
  path: string;
  rotationBytes: number;
  rotationKeep: number;
  logger: Logger;
}

export interface CockpitAnswer {
  deliveryId: string;
  [key: string]: unknown;
}

export class CockpitAnswersWriter {
  private readonly path: string;
  private readonly rotationBytes: number;
  private readonly rotationKeep: number;
  private readonly logger: Logger;

  private fd: FileHandle | null = null;
  private currentBytes = 0;
  private readonly dedup = new Set<string>();
  private mutex: Promise<void> = Promise.resolve();
  private unhealthy = false;

  constructor(options: CockpitAnswersWriterOptions) {
    this.path = options.path;
    this.rotationBytes = options.rotationBytes;
    this.rotationKeep = options.rotationKeep;
    this.logger = options.logger;
  }

  markUnhealthy(): void {
    this.unhealthy = true;
  }

  isHealthy(): boolean {
    return !this.unhealthy;
  }

  async init(): Promise<void> {
    const dir = dirname(this.path);
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });

    if (existsSync(this.path)) {
      await this.rebuildDedupFromFile();
    }

    // Open (create) the file for appending. Errors here propagate (EACCES etc).
    this.fd = await fs.open(this.path, 'a');
    try {
      await this.fd.chmod(0o644);
    } catch {
      // best-effort chmod
    }
    const stat = await this.fd.stat();
    this.currentBytes = stat.size;

    this.logger.info(
      { dedupSetSize: this.dedup.size },
      'cockpit-answers-writer initialized',
    );
  }

  private async rebuildDedupFromFile(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(this.path, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        try {
          const parsed = JSON.parse(trimmed) as { deliveryId?: unknown };
          if (typeof parsed.deliveryId === 'string' && parsed.deliveryId.length > 0) {
            this.dedup.add(parsed.deliveryId);
          } else {
            this.logger.warn(
              { line: trimmed.slice(0, 128) },
              'cockpit-answers-writer: missing deliveryId on boot scan; skipped',
            );
          }
        } catch {
          this.logger.warn(
            { line: trimmed.slice(0, 128) },
            'cockpit-answers-writer: malformed JSON on boot scan; skipped',
          );
        }
      });
      rl.on('close', () => resolvePromise());
      rl.on('error', reject);
      stream.on('error', reject);
    });
  }

  hasDelivered(deliveryId: string): boolean {
    return this.dedup.has(deliveryId);
  }

  async append(payload: CockpitAnswer): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.unhealthy) {
        throw new Error('cockpit-answers-writer is unhealthy');
      }
      if (!this.fd) {
        throw new Error('cockpit-answers-writer not initialized');
      }
      const line = `${JSON.stringify(payload)}\n`;
      const buffer = Buffer.from(line, 'utf8');
      await this.fd.write(buffer);
      this.currentBytes += buffer.byteLength;
      this.dedup.add(payload.deliveryId);
      if (this.currentBytes >= this.rotationBytes) {
        await this.rotate();
      }
    };

    const previous = this.mutex;
    let releaseResolve: () => void = () => {};
    const next = new Promise<void>((r) => {
      releaseResolve = r;
    });
    this.mutex = previous.then(() => next);
    await previous;
    try {
      await run();
    } finally {
      releaseResolve();
    }
  }

  private async rotate(): Promise<void> {
    if (!this.fd) return;
    const keep = this.rotationKeep;
    const base = this.path;

    // Close current fd before renames
    await this.fd.close();
    this.fd = null;

    // Displace oldest kept sibling, if any
    const oldestPath = `${base}.${keep}`;
    if (existsSync(oldestPath)) {
      try {
        await fs.unlink(oldestPath);
      } catch (err) {
        this.logger.error(
          { err: err instanceof Error ? err.message : String(err), path: oldestPath },
          'cockpit-answers-writer: unlink of oldest rotation failed',
        );
      }
    }

    // Promote .i → .(i+1) for i = keep-1 down to 1
    for (let i = keep - 1; i >= 1; i -= 1) {
      const from = `${base}.${i}`;
      const to = `${base}.${i + 1}`;
      if (existsSync(from)) {
        try {
          await fs.rename(from, to);
        } catch (err) {
          this.logger.error(
            {
              err: err instanceof Error ? err.message : String(err),
              from,
              to,
            },
            'cockpit-answers-writer: rotation rename failed',
          );
        }
      }
    }

    // Rename current → .1
    try {
      await fs.rename(base, `${base}.1`);
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err), path: base },
        'cockpit-answers-writer: rename to .1 failed',
      );
    }

    // Reopen new current
    this.fd = await fs.open(base, 'a');
    try {
      await this.fd.chmod(0o644);
    } catch {
      // best-effort
    }
    this.currentBytes = 0;

    this.logger.info(
      { event: 'cockpit-answers-rotated', keptSiblings: keep },
      'cockpit-answers-writer rotated',
    );
  }

  async close(): Promise<void> {
    if (this.fd) {
      try {
        await this.fd.close();
      } catch {
        // ignore
      }
      this.fd = null;
    }
  }
}
