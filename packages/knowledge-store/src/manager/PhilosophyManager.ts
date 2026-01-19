/**
 * PhilosophyManager - Manages philosophy operations with versioning
 */

import type { Philosophy } from '../types/knowledge.js';
import type { StorageProvider, VersionInfo } from '../types/storage.js';
import { validatePhilosophy } from '../validation/validator.js';

/**
 * Default empty philosophy
 */
function createDefaultPhilosophy(): Philosophy {
  return {
    values: [],
    beliefs: [],
    identity: {},
  };
}

/**
 * Manages philosophy storage and retrieval with versioning support
 */
export class PhilosophyManager {
  private readonly storage: StorageProvider;

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  /**
   * Get the storage key for a user's philosophy
   */
  private getKey(userId: string): string {
    return `${userId}/philosophy`;
  }

  /**
   * Get a user's philosophy
   */
  async get(userId: string): Promise<Philosophy> {
    const key = this.getKey(userId);
    const philosophy = await this.storage.get<Philosophy>(key);
    return philosophy ?? createDefaultPhilosophy();
  }

  /**
   * Update a user's philosophy (partial update supported)
   */
  async update(userId: string, update: Partial<Philosophy>): Promise<void> {
    const key = this.getKey(userId);
    const current = await this.get(userId);

    const updated: Philosophy = {
      values: update.values ?? current.values,
      beliefs: update.beliefs ?? current.beliefs,
      identity: update.identity
        ? { ...current.identity, ...update.identity }
        : current.identity,
    };

    const validation = validatePhilosophy(updated);
    if (!validation.success) {
      throw new Error(`Invalid philosophy: ${validation.errors?.join(', ')}`);
    }

    await this.storage.set(key, updated);
  }

  /**
   * Get philosophy history (versions)
   */
  async getHistory(userId: string): Promise<VersionInfo[]> {
    const key = this.getKey(userId);
    return this.storage.listVersions(key);
  }

  /**
   * Get a specific version of philosophy
   */
  async getVersion(userId: string, version: number): Promise<Philosophy | null> {
    const key = this.getKey(userId);
    return this.storage.getVersion<Philosophy>(key, version);
  }

  /**
   * Revert philosophy to a specific version
   */
  async revertTo(userId: string, version: number): Promise<void> {
    const key = this.getKey(userId);
    const versionData = await this.storage.getVersion<Philosophy>(key, version);

    if (!versionData) {
      throw new Error(`Version ${version} not found for user ${userId}`);
    }

    await this.storage.set(key, versionData);
  }
}
