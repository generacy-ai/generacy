import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { ClusterLocalBackend } from '@generacy-ai/credhelper';
import type { StoreStatus, StoreInitResult } from '../types/init-result.js';
import { StoreDisabledError } from '../types/init-result.js';
import type { AppConfig } from '../schemas.js';
import { isPathDenied } from '../routes/app-config.js';

const DEFAULT_VALUES_PATH = '/var/lib/generacy-app-config/values.yaml';
const FALLBACK_VALUES_PATH = '/tmp/generacy-app-config/values.yaml';
const PERMISSION_ERRORS = new Set(['EACCES', 'EPERM', 'EROFS']);

export interface AppConfigFileMetadata {
  updatedAt: string;
  size: number;
}

export interface AppConfigEnvMetadata {
  secret: boolean;
  updatedAt: string;
}

export interface AppConfigValuesMetadata {
  env: Record<string, AppConfigEnvMetadata>;
  files: Record<string, AppConfigFileMetadata>;
}

/**
 * Store for app-config file blobs and values metadata.
 * Encrypts blobs in ClusterLocalBackend, writes decoded content to mountPath,
 * and tracks metadata in a YAML file.
 */
export class AppConfigFileStore {
  private valuesPath: string;
  private status: StoreStatus = 'ok';
  private disabledReason?: string;

  constructor(
    private readonly backend: ClusterLocalBackend,
    valuesPath?: string,
  ) {
    this.valuesPath = valuesPath ?? DEFAULT_VALUES_PATH;
  }

  async init(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.valuesPath), { recursive: true });
    } catch (err: unknown) {
      if (!PERMISSION_ERRORS.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      const fallbackPath = FALLBACK_VALUES_PATH;
      try {
        await fs.mkdir(path.dirname(fallbackPath), { recursive: true });
        this.valuesPath = fallbackPath;
        this.status = 'fallback';
      } catch (err2: unknown) {
        if (!PERMISSION_ERRORS.has((err2 as NodeJS.ErrnoException).code ?? '')) throw err2;
        this.status = 'disabled';
        this.disabledReason = `Both ${path.dirname(this.valuesPath)} and ${path.dirname(fallbackPath)} failed: ${(err as NodeJS.ErrnoException).code}`;
        return;
      }
    }
  }

  getStatus(): StoreStatus {
    return this.status;
  }

  getInitResult(): StoreInitResult {
    return {
      status: this.status,
      path: this.status !== 'disabled' ? this.valuesPath : undefined,
      reason: this.status === 'fallback'
        ? `EACCES on preferred path, using ${this.valuesPath}`
        : this.disabledReason,
    };
  }

  /** Store a file blob: encrypt in backend, write to mountPath, update metadata. */
  async setFile(id: string, mountPath: string, data: Buffer): Promise<void> {
    if (this.status === 'disabled') {
      throw new StoreDisabledError('app-config-store-disabled', this.disabledReason);
    }
    const backendKey = `app-config/file/${id}`;
    const base64Data = data.toString('base64');

    // Store encrypted blob in backend
    await this.backend.setSecret(backendKey, base64Data);

    // Write decoded content to mountPath
    await this.atomicWriteFile(path.resolve(mountPath), data);

    // Update metadata
    await this.updateFileMetadata(id, data.length);
  }

  private async atomicWriteFile(absPath: string, data: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const tmpPath = `${absPath}.tmp.${process.pid}`;
    const fd = await fs.open(tmpPath, 'w', 0o640);
    try {
      await fd.writeFile(data);
      await fd.datasync();
    } finally {
      await fd.close();
    }
    await fs.rename(tmpPath, absPath);
  }

  /**
   * Boot-time full render: walk metadata for file entries, decrypt each blob,
   * resolve mountPath from manifest, write atomically. Best-effort: skip entries that fail.
   */
  async renderAll(
    readManifest: () => Promise<AppConfig | null>,
  ): Promise<{ rendered: string[]; failed: string[] }> {
    if (this.status === 'disabled') {
      return { rendered: [], failed: [] };
    }

    const meta = await this.readMetadata();
    const manifest = await readManifest();
    const rendered: string[] = [];
    const failed: string[] = [];

    const manifestFiles = new Map(
      (manifest?.files ?? []).map(f => [f.id, f]),
    );

    for (const id of Object.keys(meta.files)) {
      const fileEntry = manifestFiles.get(id);
      if (!fileEntry) {
        console.warn(`[app-config-file] Skipping orphaned file '${id}': not in current manifest`);
        failed.push(id);
        continue;
      }

      if (isPathDenied(fileEntry.mountPath)) {
        console.warn(`[app-config-file] Skipping file '${id}': mountPath '${fileEntry.mountPath}' is denylisted`);
        failed.push(id);
        continue;
      }

      try {
        const base64Data = await this.backend.fetchSecret(`app-config/file/${id}`);
        const data = Buffer.from(base64Data, 'base64');
        await this.atomicWriteFile(path.resolve(fileEntry.mountPath), data);
        rendered.push(id);
      } catch (err: unknown) {
        console.warn(
          `[app-config-file] Failed to render file '${id}':`,
          err instanceof Error ? err.message : String(err),
        );
        failed.push(id);
      }
    }

    console.log(JSON.stringify({ event: 'files-rendered', count: rendered.length, skipped: failed.length }));
    return { rendered, failed };
  }

  /** Set an env var's metadata (secret flag and timestamp). */
  async setEnvMetadata(name: string, secret: boolean): Promise<void> {
    if (this.status === 'disabled') {
      throw new StoreDisabledError('app-config-store-disabled', this.disabledReason);
    }
    const meta = await this.readMetadata();
    meta.env[name] = {
      secret,
      updatedAt: new Date().toISOString(),
    };
    await this.writeMetadata(meta);
  }

  /** Remove env metadata entry. Returns the removed entry or undefined. */
  async deleteEnvMetadata(name: string): Promise<AppConfigEnvMetadata | undefined> {
    const meta = await this.readMetadata();
    const entry = meta.env[name];
    if (entry) {
      delete meta.env[name];
      await this.writeMetadata(meta);
    }
    return entry;
  }

  /** Read all values metadata. */
  async getMetadata(): Promise<AppConfigValuesMetadata> {
    if (this.status === 'disabled') return { env: {}, files: {} };
    return this.readMetadata();
  }

  private async updateFileMetadata(id: string, size: number): Promise<void> {
    const meta = await this.readMetadata();
    meta.files[id] = {
      updatedAt: new Date().toISOString(),
      size,
    };
    await this.writeMetadata(meta);
  }

  private async readMetadata(): Promise<AppConfigValuesMetadata> {
    try {
      const raw = await fs.readFile(this.valuesPath, 'utf8');
      const parsed = YAML.parse(raw);
      return {
        env: parsed?.env && typeof parsed.env === 'object' ? parsed.env : {},
        files: parsed?.files && typeof parsed.files === 'object' ? parsed.files : {},
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { env: {}, files: {} };
      }
      throw err;
    }
  }

  private async writeMetadata(meta: AppConfigValuesMetadata): Promise<void> {
    const tmpPath = `${this.valuesPath}.tmp.${process.pid}`;
    await fs.writeFile(tmpPath, YAML.stringify(meta), { mode: 0o644 });
    await fs.rename(tmpPath, this.valuesPath);
  }
}
