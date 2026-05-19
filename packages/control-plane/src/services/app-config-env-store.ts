import fs from 'node:fs/promises';
import path from 'node:path';
import type { StoreStatus, StoreInitResult } from '../types/init-result.js';
import { StoreDisabledError } from '../types/init-result.js';

const DEFAULT_ENV_PATH = '/var/lib/generacy-app-config/env';
const FALLBACK_ENV_PATH = '/tmp/generacy-app-config/env';
const PERMISSION_ERRORS = new Set(['EACCES', 'EPERM', 'EROFS']);

/**
 * Atomic read-modify-write store for app-config environment variables.
 * Stores bare KEY="escaped_value" format compatible with Docker Compose env_file.
 * Serializes writes via an in-process mutex; this store is owned by a single
 * control-plane daemon per cluster.
 */
export class AppConfigEnvStore {
  private envPath: string;
  private writeChain: Promise<unknown> = Promise.resolve();
  private status: StoreStatus = 'ok';
  private disabledReason?: string;

  constructor(envPath?: string) {
    this.envPath = envPath ?? DEFAULT_ENV_PATH;
  }

  async init(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.envPath), { recursive: true });
    } catch (err: unknown) {
      if (!PERMISSION_ERRORS.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      // Try fallback path
      const fallbackPath = FALLBACK_ENV_PATH;
      try {
        await fs.mkdir(path.dirname(fallbackPath), { recursive: true });
        this.envPath = fallbackPath;
        this.status = 'fallback';
      } catch (err2: unknown) {
        if (!PERMISSION_ERRORS.has((err2 as NodeJS.ErrnoException).code ?? '')) throw err2;
        this.status = 'disabled';
        this.disabledReason = `Both ${path.dirname(this.envPath)} and ${path.dirname(fallbackPath)} failed: ${(err as NodeJS.ErrnoException).code}`;
        return;
      }
    }
    // Create env file if it doesn't exist
    try {
      await fs.access(this.envPath);
    } catch {
      await fs.writeFile(this.envPath, '', { mode: 0o640 });
    }
  }

  getStatus(): StoreStatus {
    return this.status;
  }

  getInitResult(): StoreInitResult {
    return {
      status: this.status,
      path: this.status !== 'disabled' ? this.envPath : undefined,
      reason: this.status === 'fallback'
        ? `EACCES on preferred path, using ${this.envPath}`
        : this.disabledReason,
    };
  }

  /** Get value of a single env var. Returns undefined if not found. */
  async get(name: string): Promise<string | undefined> {
    const entries = await this.readAll();
    return entries.get(name);
  }

  /** Set an env var. Atomic rewrite under advisory lock. */
  async set(name: string, value: string): Promise<void> {
    if (this.status === 'disabled') {
      throw new StoreDisabledError('app-config-store-disabled', this.disabledReason);
    }
    await this.withLock(async () => {
      const entries = await this.readAll();
      entries.set(name, value);
      await this.writeAll(entries);
    });
  }

  /** Delete an env var. Returns true if it existed, false otherwise. */
  async delete(name: string): Promise<boolean> {
    if (this.status === 'disabled') {
      throw new StoreDisabledError('app-config-store-disabled', this.disabledReason);
    }
    let existed = false;
    await this.withLock(async () => {
      const entries = await this.readAll();
      existed = entries.delete(name);
      if (existed) {
        await this.writeAll(entries);
      }
    });
    return existed;
  }

  /** List all env var names and their values. */
  async list(): Promise<Map<string, string>> {
    if (this.status === 'disabled') return new Map();
    return this.readAll();
  }

  /** Parse the env file into a Map<name, value>. */
  private async readAll(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    let content: string;
    try {
      content = await fs.readFile(this.envPath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw err;
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx);
      let value = trimmed.slice(eqIdx + 1);

      // Unquote
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
        value = value.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
      }

      result.set(key, value);
    }

    return result;
  }

  /** Serialize and atomically write the env file. */
  private async writeAll(entries: Map<string, string>): Promise<void> {
    const lines: string[] = [];
    for (const [key, value] of entries) {
      lines.push(`${key}="${escapeValue(value)}"`);
    }
    const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');

    const tmpPath = `${this.envPath}.tmp.${process.pid}`;
    const fd = await fs.open(tmpPath, 'w', 0o640);
    try {
      await fd.writeFile(content);
      await fd.datasync();
    } finally {
      await fd.close();
    }
    await fs.rename(tmpPath, this.envPath);
  }

  /** Serialize writes through an in-process promise chain. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}

/** Escape a value for double-quoted env format. */
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}
