/**
 * Auditable storage wrapper
 * Adds audit trail logging to any StorageProvider
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import type { StorageProvider, VersionInfo } from '../types/storage.js';
import { now } from '../utils/timestamps.js';

/**
 * Audit log entry
 */
export interface AuditEntry {
  timestamp: string;
  action: 'set' | 'delete' | 'createVersion';
  key: string;
  details?: Record<string, unknown>;
}

/**
 * Auditable storage wrapper that logs all modifications
 */
export class AuditableStorage implements StorageProvider {
  private readonly storage: StorageProvider;
  private readonly auditPath: string;
  private readonly enabled: boolean;

  constructor(
    storage: StorageProvider,
    baseDir: string,
    enabled: boolean = true
  ) {
    this.storage = storage;
    this.auditPath = join(baseDir, 'audit.json');
    this.enabled = enabled;
  }

  /**
   * Append an entry to the audit log
   */
  private async appendAudit(entry: AuditEntry): Promise<void> {
    if (!this.enabled) return;

    try {
      await fs.mkdir(dirname(this.auditPath), { recursive: true });

      let entries: AuditEntry[] = [];
      try {
        const data = await fs.readFile(this.auditPath, 'utf-8');
        entries = JSON.parse(data);
      } catch {
        // File doesn't exist or is invalid, start fresh
      }

      entries.push(entry);

      // Keep only last 1000 entries
      if (entries.length > 1000) {
        entries = entries.slice(-1000);
      }

      await fs.writeFile(this.auditPath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch {
      // Audit logging should not fail the operation
    }
  }

  /**
   * Get the audit log entries
   */
  async getAuditLog(): Promise<AuditEntry[]> {
    try {
      const data = await fs.readFile(this.auditPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  // StorageProvider implementation

  async get<T>(key: string): Promise<T | null> {
    return this.storage.get<T>(key);
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.storage.set(key, value);
    await this.appendAudit({
      timestamp: now(),
      action: 'set',
      key,
      details: { type: typeof value },
    });
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
    await this.appendAudit({
      timestamp: now(),
      action: 'delete',
      key,
    });
  }

  async list(prefix: string): Promise<string[]> {
    return this.storage.list(prefix);
  }

  async exists(key: string): Promise<boolean> {
    return this.storage.exists(key);
  }

  async getVersion<T>(key: string, version: number): Promise<T | null> {
    return this.storage.getVersion<T>(key, version);
  }

  async listVersions(key: string): Promise<VersionInfo[]> {
    return this.storage.listVersions(key);
  }

  async createVersion(key: string): Promise<number> {
    const version = await this.storage.createVersion(key);
    await this.appendAudit({
      timestamp: now(),
      action: 'createVersion',
      key,
      details: { version },
    });
    return version;
  }

  /**
   * Get the underlying storage provider
   */
  getUnderlyingStorage(): StorageProvider {
    return this.storage;
  }
}
