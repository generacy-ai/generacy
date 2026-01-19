/**
 * Storage provider types
 * Based on data-model.md specification
 */

/**
 * Information about a stored version
 */
export interface VersionInfo {
  version: number;
  timestamp: string;
  size: number; // Bytes
}

/**
 * Abstract storage provider interface
 */
export interface StorageProvider {
  /**
   * Get a value by key
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Set a value by key
   */
  set<T>(key: string, value: T): Promise<void>;

  /**
   * Delete a value by key
   */
  delete(key: string): Promise<void>;

  /**
   * List all keys with a given prefix
   */
  list(prefix: string): Promise<string[]>;

  /**
   * Check if a key exists
   */
  exists(key: string): Promise<boolean>;

  /**
   * Get a specific version of a value
   */
  getVersion<T>(key: string, version: number): Promise<T | null>;

  /**
   * List all versions for a key
   */
  listVersions(key: string): Promise<VersionInfo[]>;

  /**
   * Create a new version for a key (returns version number)
   */
  createVersion(key: string): Promise<number>;
}

/**
 * Configuration for knowledge store
 */
export interface KnowledgeStoreConfig {
  baseDir?: string;
  maxVersions?: number;
  enableAudit?: boolean;
}
