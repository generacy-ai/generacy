/**
 * Abstract storage provider interface
 * Defines the contract for all storage implementations
 */

import type { StorageProvider, VersionInfo } from '../types/storage.js';

export type { StorageProvider, VersionInfo };

/**
 * Error thrown when a storage operation fails
 */
export class StorageError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly key?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Error thrown when a key is not found
 */
export class KeyNotFoundError extends StorageError {
  constructor(key: string) {
    super(`Key not found: ${key}`, 'get', key);
    this.name = 'KeyNotFoundError';
  }
}

/**
 * Error thrown when a version is not found
 */
export class VersionNotFoundError extends StorageError {
  constructor(key: string, version: number) {
    super(`Version ${version} not found for key: ${key}`, 'getVersion', key);
    this.name = 'VersionNotFoundError';
  }
}
