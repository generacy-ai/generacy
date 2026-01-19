/**
 * Local file-based storage provider
 * Implements atomic writes using temp file + rename pattern
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import type { StorageProvider, VersionInfo } from '../types/storage.js';
import { StorageError } from './StorageProvider.js';

/**
 * Local file storage implementation
 * Stores data as JSON files in the filesystem
 */
export class LocalFileStorage implements StorageProvider {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Get the full file path for a key
   */
  private getPath(key: string): string {
    return join(this.baseDir, `${key}.json`);
  }

  /**
   * Get the version directory for a key
   */
  private getVersionDir(key: string): string {
    return join(this.baseDir, 'versions', key);
  }

  /**
   * Get the version file path
   */
  private getVersionPath(key: string, version: number): string {
    return join(this.getVersionDir(key), `v${version}.json`);
  }

  /**
   * Ensure a directory exists
   */
  private async ensureDir(path: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
  }

  /**
   * Get a value by key
   */
  async get<T>(key: string): Promise<T | null> {
    const path = this.getPath(key);
    try {
      const data = await fs.readFile(path, 'utf-8');
      return JSON.parse(data) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new StorageError(
        `Failed to read key: ${key}`,
        'get',
        key,
        error as Error
      );
    }
  }

  /**
   * Set a value by key using atomic write (temp file + rename)
   */
  async set<T>(key: string, value: T): Promise<void> {
    const path = this.getPath(key);
    const tempPath = `${path}.tmp.${Date.now()}`;

    try {
      await this.ensureDir(path);
      const data = JSON.stringify(value, null, 2);
      await fs.writeFile(tempPath, data, 'utf-8');
      await fs.rename(tempPath, path);
    } catch (error) {
      // Clean up temp file if it exists
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new StorageError(
        `Failed to write key: ${key}`,
        'set',
        key,
        error as Error
      );
    }
  }

  /**
   * Delete a value by key
   */
  async delete(key: string): Promise<void> {
    const path = this.getPath(key);
    try {
      await fs.unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError(
          `Failed to delete key: ${key}`,
          'delete',
          key,
          error as Error
        );
      }
    }
  }

  /**
   * List all keys with a given prefix
   */
  async list(prefix: string): Promise<string[]> {
    const searchDir = join(this.baseDir, dirname(prefix));
    const filePrefix = prefix.split('/').pop() || '';

    try {
      const entries = await fs.readdir(searchDir, { withFileTypes: true });
      return entries
        .filter((entry) => {
          if (!entry.isFile() || !entry.name.endsWith('.json')) {
            return false;
          }
          const keyName = entry.name.replace('.json', '');
          return keyName.startsWith(filePrefix);
        })
        .map((entry) => {
          const relativePath = dirname(prefix);
          const keyName = entry.name.replace('.json', '');
          return relativePath === '.' ? keyName : `${relativePath}/${keyName}`;
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw new StorageError(
        `Failed to list keys with prefix: ${prefix}`,
        'list',
        prefix,
        error as Error
      );
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    const path = this.getPath(key);
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a specific version of a value
   */
  async getVersion<T>(key: string, version: number): Promise<T | null> {
    const path = this.getVersionPath(key, version);
    try {
      const data = await fs.readFile(path, 'utf-8');
      return JSON.parse(data) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new StorageError(
        `Failed to read version ${version} for key: ${key}`,
        'getVersion',
        key,
        error as Error
      );
    }
  }

  /**
   * List all versions for a key
   */
  async listVersions(key: string): Promise<VersionInfo[]> {
    const versionDir = this.getVersionDir(key);
    try {
      const entries = await fs.readdir(versionDir, { withFileTypes: true });
      const versions: VersionInfo[] = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith('v') || !entry.name.endsWith('.json')) {
          continue;
        }

        const versionStr = entry.name.replace('v', '').replace('.json', '');
        const version = parseInt(versionStr, 10);
        if (isNaN(version)) {
          continue;
        }

        const filePath = join(versionDir, entry.name);
        const stat = await fs.stat(filePath);
        versions.push({
          version,
          timestamp: stat.mtime.toISOString(),
          size: stat.size,
        });
      }

      return versions.sort((a, b) => a.version - b.version);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw new StorageError(
        `Failed to list versions for key: ${key}`,
        'listVersions',
        key,
        error as Error
      );
    }
  }

  /**
   * Create a new version for a key (copies current value to version file)
   * Returns the new version number
   */
  async createVersion(key: string): Promise<number> {
    const current = await this.get(key);
    if (current === null) {
      throw new StorageError(
        `Cannot create version for non-existent key: ${key}`,
        'createVersion',
        key
      );
    }

    const versions = await this.listVersions(key);
    const newVersion = versions.length > 0
      ? Math.max(...versions.map((v) => v.version)) + 1
      : 1;

    const versionPath = this.getVersionPath(key, newVersion);
    const tempPath = `${versionPath}.tmp.${Date.now()}`;

    try {
      await this.ensureDir(versionPath);
      const data = JSON.stringify(current, null, 2);
      await fs.writeFile(tempPath, data, 'utf-8');
      await fs.rename(tempPath, versionPath);
      return newVersion;
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new StorageError(
        `Failed to create version for key: ${key}`,
        'createVersion',
        key,
        error as Error
      );
    }
  }
}
