/**
 * PatternManager - Manages pattern CRUD operations with status filtering and promotion
 */

import type { Pattern, PatternStatus, PatternOccurrence } from '../types/knowledge.js';
import type { StorageProvider } from '../types/storage.js';
import { validatePattern } from '../validation/validator.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/timestamps.js';
import type { PrincipleManager, CreatePrincipleInput } from './PrincipleManager.js';

/**
 * Input for creating a new pattern
 */
export interface CreatePatternInput {
  description: string;
  domain: string[];
  occurrences?: PatternOccurrence[];
}

/**
 * Input for updating a pattern
 */
export interface UpdatePatternInput {
  description?: string;
  domain?: string[];
  status?: PatternStatus;
}

/**
 * Manages patterns storage and retrieval with filtering and promotion
 */
export class PatternManager {
  private readonly storage: StorageProvider;
  private principleManager?: PrincipleManager;

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  /**
   * Set the principle manager for pattern promotion
   */
  setPrincipleManager(manager: PrincipleManager): void {
    this.principleManager = manager;
  }

  /**
   * Get the storage key for a user's patterns
   */
  private getKey(userId: string): string {
    return `${userId}/patterns`;
  }

  /**
   * Get all patterns for a user, optionally filtered by status
   */
  async get(userId: string, status?: PatternStatus): Promise<Pattern[]> {
    const key = this.getKey(userId);
    const patterns = await this.storage.get<Pattern[]>(key);

    if (!patterns) {
      return [];
    }

    if (!status) {
      return patterns;
    }

    return patterns.filter((p) => p.status === status);
  }

  /**
   * Get a specific pattern by ID
   */
  async getById(userId: string, patternId: string): Promise<Pattern | null> {
    const patterns = await this.get(userId);
    return patterns.find((p) => p.id === patternId) ?? null;
  }

  /**
   * Add a new pattern
   */
  async add(userId: string, input: CreatePatternInput): Promise<string> {
    const key = this.getKey(userId);
    const patterns = await this.get(userId);
    const timestamp = now();

    const pattern: Pattern = {
      id: generateId(),
      description: input.description,
      occurrences: input.occurrences ?? [],
      status: 'emerging',
      domain: input.domain,
      firstSeen: timestamp,
      lastSeen: timestamp,
    };

    const validation = validatePattern(pattern);
    if (!validation.success) {
      throw new Error(`Invalid pattern: ${validation.errors?.join(', ')}`);
    }

    patterns.push(pattern);
    await this.storage.set(key, patterns);

    return pattern.id;
  }

  /**
   * Update an existing pattern
   */
  async update(
    userId: string,
    patternId: string,
    update: UpdatePatternInput
  ): Promise<void> {
    const key = this.getKey(userId);
    const patterns = await this.get(userId);
    const index = patterns.findIndex((p) => p.id === patternId);

    if (index === -1) {
      throw new Error(`Pattern not found: ${patternId}`);
    }

    const current = patterns[index]!;
    const updated: Pattern = {
      ...current,
      description: update.description ?? current.description,
      domain: update.domain ?? current.domain,
      status: update.status ?? current.status,
      lastSeen: now(),
    };

    const validation = validatePattern(updated);
    if (!validation.success) {
      throw new Error(`Invalid pattern: ${validation.errors?.join(', ')}`);
    }

    patterns[index] = updated;
    await this.storage.set(key, patterns);
  }

  /**
   * Add an occurrence to a pattern
   */
  async addOccurrence(
    userId: string,
    patternId: string,
    occurrence: Omit<PatternOccurrence, 'timestamp'>
  ): Promise<void> {
    const key = this.getKey(userId);
    const patterns = await this.get(userId);
    const index = patterns.findIndex((p) => p.id === patternId);

    if (index === -1) {
      throw new Error(`Pattern not found: ${patternId}`);
    }

    const current = patterns[index]!;
    const timestamp = now();

    patterns[index] = {
      ...current,
      occurrences: [
        ...current.occurrences,
        { ...occurrence, timestamp },
      ],
      lastSeen: timestamp,
      // Auto-promote to established if enough occurrences
      status:
        current.status === 'emerging' && current.occurrences.length >= 2
          ? 'established'
          : current.status,
    };

    await this.storage.set(key, patterns);
  }

  /**
   * Promote a pattern to a principle
   * Returns the new principle ID
   */
  async promoteToAnciple(userId: string, patternId: string): Promise<string> {
    if (!this.principleManager) {
      throw new Error('PrincipleManager not set. Call setPrincipleManager first.');
    }

    const pattern = await this.getById(userId, patternId);
    if (!pattern) {
      throw new Error(`Pattern not found: ${patternId}`);
    }

    if (pattern.status === 'promoted') {
      throw new Error(`Pattern already promoted: ${patternId}`);
    }

    // Create principle from pattern
    const principleInput: CreatePrincipleInput = {
      content: pattern.description,
      domain: pattern.domain,
      weight: 0.6, // Start with moderate weight
      evidence: pattern.occurrences.map((o) => ({
        decision: o.decision,
        context: o.context,
        timestamp: o.timestamp,
      })),
      status: 'draft',
      source: `Promoted from pattern ${patternId}`,
    };

    const principleId = await this.principleManager.add(userId, principleInput);

    // Update pattern status
    const key = this.getKey(userId);
    const patterns = await this.get(userId);
    const index = patterns.findIndex((p) => p.id === patternId);

    if (index !== -1) {
      patterns[index] = {
        ...patterns[index]!,
        status: 'promoted',
        promotedTo: principleId,
        lastSeen: now(),
      };
      await this.storage.set(key, patterns);
    }

    return principleId;
  }

  /**
   * Reject a pattern
   */
  async reject(userId: string, patternId: string): Promise<void> {
    await this.update(userId, patternId, { status: 'rejected' });
  }

  /**
   * Delete a pattern (hard delete)
   */
  async delete(userId: string, patternId: string): Promise<void> {
    const key = this.getKey(userId);
    const patterns = await this.get(userId);
    const filtered = patterns.filter((p) => p.id !== patternId);

    if (filtered.length === patterns.length) {
      throw new Error(`Pattern not found: ${patternId}`);
    }

    await this.storage.set(key, filtered);
  }
}
