/**
 * Versioned storage wrapper
 * Adds automatic versioning to any StorageProvider
 */

import type { StorageProvider, VersionInfo } from '../types/storage.js';

/**
 * Configuration for versioned storage
 */
export interface VersionedStorageConfig {
  maxVersions: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: VersionedStorageConfig = {
  maxVersions: 50,
};

/**
 * Versioned storage wrapper that adds automatic versioning to any storage provider
 * Uses full snapshot strategy - each version is a complete copy
 */
export class VersionedStorage implements StorageProvider {
  private readonly storage: StorageProvider;
  private readonly config: VersionedStorageConfig;

  constructor(storage: StorageProvider, config: Partial<VersionedStorageConfig> = {}) {
    this.storage = storage;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get a value by key (delegates to underlying storage)
   */
  async get<T>(key: string): Promise<T | null> {
    return this.storage.get<T>(key);
  }

  /**
   * Set a value by key, creating a version if data already exists
   */
  async set<T>(key: string, value: T): Promise<void> {
    // Check if data exists and create a version before updating
    const exists = await this.storage.exists(key);
    if (exists) {
      await this.storage.createVersion(key);
      await this.pruneOldVersions(key);
    }

    await this.storage.set(key, value);
  }

  /**
   * Delete a value by key (delegates to underlying storage)
   */
  async delete(key: string): Promise<void> {
    return this.storage.delete(key);
  }

  /**
   * List all keys with a given prefix (delegates to underlying storage)
   */
  async list(prefix: string): Promise<string[]> {
    return this.storage.list(prefix);
  }

  /**
   * Check if a key exists (delegates to underlying storage)
   */
  async exists(key: string): Promise<boolean> {
    return this.storage.exists(key);
  }

  /**
   * Get a specific version of a value (delegates to underlying storage)
   */
  async getVersion<T>(key: string, version: number): Promise<T | null> {
    return this.storage.getVersion<T>(key, version);
  }

  /**
   * List all versions for a key (delegates to underlying storage)
   */
  async listVersions(key: string): Promise<VersionInfo[]> {
    return this.storage.listVersions(key);
  }

  /**
   * Create a new version for a key (delegates to underlying storage)
   */
  async createVersion(key: string): Promise<number> {
    const version = await this.storage.createVersion(key);
    await this.pruneOldVersions(key);
    return version;
  }

  /**
   * Prune old versions to stay within maxVersions limit
   */
  private async pruneOldVersions(key: string): Promise<void> {
    const versions = await this.storage.listVersions(key);
    if (versions.length <= this.config.maxVersions) {
      return;
    }

    // Remove oldest versions (lowest version numbers)
    const versionsToRemove = versions
      .slice(0, versions.length - this.config.maxVersions);

    for (const _version of versionsToRemove) {
      // Note: We can't directly delete version files through the StorageProvider interface
      // This would require extending the interface or handling it in the underlying storage
      // For now, we'll leave this as a TODO for the pruning implementation
    }
  }

  /**
   * Get the underlying storage provider
   */
  getUnderlyingStorage(): StorageProvider {
    return this.storage;
  }
}
