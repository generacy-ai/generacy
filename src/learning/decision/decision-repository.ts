/**
 * Decision Repository
 *
 * Repository interface and in-memory implementation for storing captured decisions.
 * Uses the repository pattern to allow pluggable storage backends.
 */

import type { CapturedDecision, DecisionQueryOptions } from '../types.js';

/**
 * Repository interface for captured decisions.
 * Enables pluggable storage backends (in-memory, Redis, Neo4j, etc.)
 */
export interface DecisionRepository {
  /**
   * Save a captured decision
   * @param decision - The decision to save
   */
  save(decision: CapturedDecision): Promise<void>;

  /**
   * Get a decision by its ID
   * @param id - The decision ID
   * @returns The decision or null if not found
   */
  getById(id: string): Promise<CapturedDecision | null>;

  /**
   * Get all decisions for a user
   * @param userId - The user ID
   * @param options - Query options for pagination and filtering
   * @returns Array of decisions
   */
  getByUserId(userId: string, options?: DecisionQueryOptions): Promise<CapturedDecision[]>;

  /**
   * Get all override decisions for a user
   * @param userId - The user ID
   * @param options - Query options for pagination and filtering
   * @returns Array of override decisions
   */
  getOverrides(userId: string, options?: DecisionQueryOptions): Promise<CapturedDecision[]>;

  /**
   * Count total decisions for a user
   * @param userId - The user ID
   * @returns Total count
   */
  count(userId: string): Promise<number>;

  /**
   * Delete a decision by ID
   * @param id - The decision ID
   * @returns True if deleted, false if not found
   */
  delete(id: string): Promise<boolean>;

  /**
   * Clear all decisions (for testing)
   */
  clear(): Promise<void>;
}

/**
 * In-memory implementation of DecisionRepository.
 * Suitable for testing and MVP; can be swapped for persistent storage later.
 */
export class InMemoryDecisionRepository implements DecisionRepository {
  private decisions: Map<string, CapturedDecision> = new Map();
  private userIndex: Map<string, Set<string>> = new Map();

  async save(decision: CapturedDecision): Promise<void> {
    // Store the decision
    this.decisions.set(decision.id, decision);

    // Update user index
    if (!this.userIndex.has(decision.userId)) {
      this.userIndex.set(decision.userId, new Set());
    }
    this.userIndex.get(decision.userId)!.add(decision.id);
  }

  async getById(id: string): Promise<CapturedDecision | null> {
    return this.decisions.get(id) ?? null;
  }

  async getByUserId(userId: string, options?: DecisionQueryOptions): Promise<CapturedDecision[]> {
    const decisionIds = this.userIndex.get(userId);
    if (!decisionIds) {
      return [];
    }

    let decisions = Array.from(decisionIds)
      .map(id => this.decisions.get(id)!)
      .filter(Boolean);

    // Apply date range filter
    if (options?.dateRange) {
      decisions = decisions.filter(d => {
        const timestamp = d.timestamp.getTime();
        if (options.dateRange!.from && timestamp < options.dateRange!.from.getTime()) {
          return false;
        }
        if (options.dateRange!.to && timestamp > options.dateRange!.to.getTime()) {
          return false;
        }
        return true;
      });
    }

    // Sort by timestamp (default: descending)
    const direction = options?.direction ?? 'desc';
    decisions.sort((a, b) => {
      const comparison = a.timestamp.getTime() - b.timestamp.getTime();
      return direction === 'desc' ? -comparison : comparison;
    });

    // Apply pagination
    const offset = options?.offset ?? 0;
    const limit = options?.limit;

    if (limit !== undefined) {
      return decisions.slice(offset, offset + limit);
    }

    return decisions.slice(offset);
  }

  async getOverrides(userId: string, options?: DecisionQueryOptions): Promise<CapturedDecision[]> {
    const allDecisions = await this.getByUserId(userId, options);
    return allDecisions.filter(d => d.wasOverride);
  }

  async count(userId: string): Promise<number> {
    const decisionIds = this.userIndex.get(userId);
    return decisionIds?.size ?? 0;
  }

  async delete(id: string): Promise<boolean> {
    const decision = this.decisions.get(id);
    if (!decision) {
      return false;
    }

    this.decisions.delete(id);
    this.userIndex.get(decision.userId)?.delete(id);
    return true;
  }

  async clear(): Promise<void> {
    this.decisions.clear();
    this.userIndex.clear();
  }
}
