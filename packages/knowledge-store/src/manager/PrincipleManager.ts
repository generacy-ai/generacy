/**
 * PrincipleManager - Manages principle CRUD operations with domain filtering and deprecation
 */

import type { Principle, PrincipleStatus } from '../types/knowledge.js';
import type { StorageProvider, VersionInfo } from '../types/storage.js';
import { validatePrinciple } from '../validation/validator.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/timestamps.js';

/**
 * Input for creating a new principle (without id and metadata)
 */
export interface CreatePrincipleInput {
  content: string;
  domain: string[];
  weight?: number;
  evidence?: Principle['evidence'];
  status?: PrincipleStatus;
  source?: string;
}

/**
 * Input for updating a principle
 */
export interface UpdatePrincipleInput {
  content?: string;
  domain?: string[];
  weight?: number;
  evidence?: Principle['evidence'];
  status?: PrincipleStatus;
}

/**
 * Manages principles storage and retrieval with filtering and versioning
 */
export class PrincipleManager {
  private readonly storage: StorageProvider;

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  /**
   * Get the storage key for a user's principles
   */
  private getKey(userId: string): string {
    return `${userId}/principles`;
  }

  /**
   * Get all principles for a user, optionally filtered by domains
   */
  async get(userId: string, domains?: string[]): Promise<Principle[]> {
    const key = this.getKey(userId);
    const principles = await this.storage.get<Principle[]>(key);

    if (!principles) {
      return [];
    }

    if (!domains || domains.length === 0) {
      return principles;
    }

    // Filter by domains - principle must have at least one matching domain
    return principles.filter((p) =>
      p.domain.some((d) => domains.includes(d))
    );
  }

  /**
   * Get a specific principle by ID
   */
  async getById(userId: string, principleId: string): Promise<Principle | null> {
    const principles = await this.get(userId);
    return principles.find((p) => p.id === principleId) ?? null;
  }

  /**
   * Add a new principle
   */
  async add(userId: string, input: CreatePrincipleInput): Promise<string> {
    const key = this.getKey(userId);
    const principles = await this.get(userId);
    const timestamp = now();

    const principle: Principle = {
      id: generateId(),
      content: input.content,
      domain: input.domain,
      weight: input.weight ?? 0.5,
      evidence: input.evidence ?? [],
      status: input.status ?? 'draft',
      metadata: {
        createdAt: timestamp,
        updatedAt: timestamp,
        source: input.source,
      },
    };

    const validation = validatePrinciple(principle);
    if (!validation.success) {
      throw new Error(`Invalid principle: ${validation.errors?.join(', ')}`);
    }

    principles.push(principle);
    await this.storage.set(key, principles);

    return principle.id;
  }

  /**
   * Update an existing principle
   */
  async update(
    userId: string,
    principleId: string,
    update: UpdatePrincipleInput
  ): Promise<void> {
    const key = this.getKey(userId);
    const principles = await this.get(userId);
    const index = principles.findIndex((p) => p.id === principleId);

    if (index === -1) {
      throw new Error(`Principle not found: ${principleId}`);
    }

    const current = principles[index]!;
    const updated: Principle = {
      ...current,
      content: update.content ?? current.content,
      domain: update.domain ?? current.domain,
      weight: update.weight ?? current.weight,
      evidence: update.evidence ?? current.evidence,
      status: update.status ?? current.status,
      metadata: {
        ...current.metadata,
        updatedAt: now(),
      },
    };

    const validation = validatePrinciple(updated);
    if (!validation.success) {
      throw new Error(`Invalid principle: ${validation.errors?.join(', ')}`);
    }

    principles[index] = updated;
    await this.storage.set(key, principles);
  }

  /**
   * Deprecate a principle
   */
  async deprecate(
    userId: string,
    principleId: string,
    reason: string
  ): Promise<void> {
    const key = this.getKey(userId);
    const principles = await this.get(userId);
    const index = principles.findIndex((p) => p.id === principleId);

    if (index === -1) {
      throw new Error(`Principle not found: ${principleId}`);
    }

    const current = principles[index]!;
    const timestamp = now();

    principles[index] = {
      ...current,
      status: 'deprecated',
      metadata: {
        ...current.metadata,
        updatedAt: timestamp,
        deprecatedAt: timestamp,
        deprecationReason: reason,
      },
    };

    await this.storage.set(key, principles);
  }

  /**
   * Delete a principle (hard delete)
   */
  async delete(userId: string, principleId: string): Promise<void> {
    const key = this.getKey(userId);
    const principles = await this.get(userId);
    const filtered = principles.filter((p) => p.id !== principleId);

    if (filtered.length === principles.length) {
      throw new Error(`Principle not found: ${principleId}`);
    }

    await this.storage.set(key, filtered);
  }

  /**
   * Get principles by status
   */
  async getByStatus(userId: string, status: PrincipleStatus): Promise<Principle[]> {
    const principles = await this.get(userId);
    return principles.filter((p) => p.status === status);
  }

  /**
   * Get principles history (versions)
   */
  async getHistory(userId: string): Promise<VersionInfo[]> {
    const key = this.getKey(userId);
    return this.storage.listVersions(key);
  }

  /**
   * Get a specific version of principles
   */
  async getVersion(userId: string, version: number): Promise<Principle[] | null> {
    const key = this.getKey(userId);
    return this.storage.getVersion<Principle[]>(key, version);
  }
}
