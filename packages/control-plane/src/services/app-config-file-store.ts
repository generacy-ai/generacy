import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { ClusterLocalBackend } from '@generacy-ai/credhelper';

const DEFAULT_VALUES_PATH = '/var/lib/generacy-app-config/values.yaml';

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
  private readonly valuesPath: string;

  constructor(
    private readonly backend: ClusterLocalBackend,
    valuesPath?: string,
  ) {
    this.valuesPath = valuesPath ?? DEFAULT_VALUES_PATH;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.valuesPath), { recursive: true });
  }

  /** Store a file blob: encrypt in backend, write to mountPath, update metadata. */
  async setFile(id: string, mountPath: string, data: Buffer): Promise<void> {
    const backendKey = `app-config/file/${id}`;
    const base64Data = data.toString('base64');

    // Store encrypted blob in backend
    await this.backend.setSecret(backendKey, base64Data);

    // Write decoded content to mountPath (atomic: temp + rename)
    const absPath = path.resolve(mountPath);
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

    // Update metadata
    await this.updateFileMetadata(id, data.length);
  }

  /** Set an env var's metadata (secret flag and timestamp). */
  async setEnvMetadata(name: string, secret: boolean): Promise<void> {
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
