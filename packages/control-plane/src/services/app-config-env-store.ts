import fs from 'node:fs/promises';
import fsSyncModule from 'node:fs';
import path from 'node:path';

const DEFAULT_ENV_PATH = '/var/lib/generacy-app-config/env';

/**
 * Atomic read-modify-write store for app-config environment variables.
 * Stores bare KEY="escaped_value" format compatible with Docker Compose env_file.
 * Uses advisory file locking via a .lock file for concurrency.
 */
export class AppConfigEnvStore {
  private readonly envPath: string;
  private readonly lockPath: string;

  constructor(envPath?: string) {
    this.envPath = envPath ?? DEFAULT_ENV_PATH;
    this.lockPath = `${this.envPath}.lock`;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.envPath), { recursive: true });
    // Create env file if it doesn't exist
    try {
      await fs.access(this.envPath);
    } catch {
      await fs.writeFile(this.envPath, '', { mode: 0o640 });
    }
  }

  /** Get value of a single env var. Returns undefined if not found. */
  async get(name: string): Promise<string | undefined> {
    const entries = await this.readAll();
    return entries.get(name);
  }

  /** Set an env var. Atomic rewrite under advisory lock. */
  async set(name: string, value: string): Promise<void> {
    await this.withLock(async () => {
      const entries = await this.readAll();
      entries.set(name, value);
      await this.writeAll(entries);
    });
  }

  /** Delete an env var. Returns true if it existed, false otherwise. */
  async delete(name: string): Promise<boolean> {
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

  /** Simple advisory lock using a lock file. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockFd = await fs.open(this.lockPath, 'w');
    try {
      await (lockFd as unknown as { lock(exclusive: boolean): Promise<void> }).lock(true);
      return await fn();
    } finally {
      await lockFd.close();
    }
  }
}

/** Escape a value for double-quoted env format. */
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}
