import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isPostActivationSettledSync } from './post-activation-settled-probe.js';

const DEFAULT_MARKER_PATH = '/var/lib/generacy/post-activation-restart-done';

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PostActivationSettledMonitorOptions {
  /** Callback invoked exactly once when the post-activation marker appears. */
  onSettled: () => void;
  /** Marker file path (default: `/var/lib/generacy/post-activation-restart-done`). */
  markerPath?: string;
  /** Optional key-file path for predicate override (test-only). */
  keyFilePath?: string;
  /** Optional logger. */
  logger?: Logger;
}

/**
 * Watches for the post-activation-restart-done marker to appear and fires
 * `onSettled` exactly once. If the predicate is already true at `start()`,
 * no watcher is installed (readiness cannot change back to `false`).
 */
export class PostActivationSettledMonitor {
  private readonly onSettled: () => void;
  private readonly markerPath: string;
  private readonly keyFilePath: string | undefined;
  private readonly logger: Logger | undefined;
  private watcher: FSWatcher | undefined;
  private started = false;
  private fired = false;

  constructor(options: PostActivationSettledMonitorOptions) {
    this.onSettled = options.onSettled;
    this.markerPath = options.markerPath ?? DEFAULT_MARKER_PATH;
    this.keyFilePath = options.keyFilePath;
    this.logger = options.logger;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const paths: { keyFilePath?: string; markerPath?: string } = { markerPath: this.markerPath };
    if (this.keyFilePath !== undefined) {
      paths.keyFilePath = this.keyFilePath;
    }
    if (isPostActivationSettledSync(paths)) {
      return;
    }

    const dir = dirname(this.markerPath);
    const base = basename(this.markerPath);

    if (!existsSync(dir)) {
      this.logger?.warn(
        { markerDir: dir },
        'PostActivationSettledMonitor: watch directory does not exist; not installing watcher',
      );
      return;
    }

    try {
      this.watcher = watch(dir, (_eventType, filename) => {
        if (this.fired) return;
        if (filename !== base) return;
        if (!existsSync(this.markerPath)) return;
        this.fired = true;
        try {
          this.onSettled();
        } finally {
          this.closeWatcher();
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn(
        { markerDir: dir, err: message },
        'PostActivationSettledMonitor: failed to install fs.watch',
      );
    }
  }

  stop(): void {
    this.closeWatcher();
    this.started = false;
  }

  private closeWatcher(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // Ignore
      }
      this.watcher = undefined;
    }
  }
}
