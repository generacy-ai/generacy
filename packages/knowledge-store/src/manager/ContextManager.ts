/**
 * ContextManager - Manages user context operations (no versioning needed)
 */

import type { UserContext, RecentDecision, CurrentProject, UserPreferences } from '../types/knowledge.js';
import type { StorageProvider } from '../types/storage.js';
import { validateContext } from '../validation/validator.js';
import { now } from '../utils/timestamps.js';

/**
 * Default empty context
 */
function createDefaultContext(): UserContext {
  return {
    recentDecisions: [],
    activeGoals: [],
    preferences: {
      verbosity: 'normal',
    },
  };
}

/**
 * Manages user context storage and retrieval
 * Context is temporary and does not require versioning
 */
export class ContextManager {
  private readonly storage: StorageProvider;

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  /**
   * Get the storage key for a user's context
   */
  private getKey(userId: string): string {
    return `${userId}/context`;
  }

  /**
   * Get a user's context
   */
  async get(userId: string): Promise<UserContext> {
    const key = this.getKey(userId);
    const context = await this.storage.get<UserContext>(key);
    return context ?? createDefaultContext();
  }

  /**
   * Update a user's context (partial update supported)
   */
  async update(userId: string, update: Partial<UserContext>): Promise<void> {
    const key = this.getKey(userId);
    const current = await this.get(userId);

    const updated: UserContext = {
      currentProject: 'currentProject' in update
        ? update.currentProject
        : current.currentProject,
      recentDecisions: update.recentDecisions ?? current.recentDecisions,
      activeGoals: update.activeGoals ?? current.activeGoals,
      preferences: update.preferences
        ? { ...current.preferences, ...update.preferences }
        : current.preferences,
    };

    const validation = validateContext(updated);
    if (!validation.success) {
      throw new Error(`Invalid context: ${validation.errors?.join(', ')}`);
    }

    await this.storage.set(key, updated);
  }

  /**
   * Set the current project
   */
  async setCurrentProject(userId: string, project: CurrentProject | undefined): Promise<void> {
    await this.update(userId, { currentProject: project });
  }

  /**
   * Add a recent decision
   */
  async addRecentDecision(
    userId: string,
    decision: Omit<RecentDecision, 'timestamp'>
  ): Promise<void> {
    const current = await this.get(userId);
    const timestamp = now();

    const newDecision: RecentDecision = {
      ...decision,
      timestamp,
    };

    // Keep only the last 50 decisions
    const recentDecisions = [newDecision, ...current.recentDecisions].slice(0, 50);

    await this.update(userId, { recentDecisions });
  }

  /**
   * Update active goals
   */
  async setActiveGoals(userId: string, goals: string[]): Promise<void> {
    await this.update(userId, { activeGoals: goals });
  }

  /**
   * Add an active goal
   */
  async addActiveGoal(userId: string, goal: string): Promise<void> {
    const current = await this.get(userId);
    if (!current.activeGoals.includes(goal)) {
      await this.update(userId, { activeGoals: [...current.activeGoals, goal] });
    }
  }

  /**
   * Remove an active goal
   */
  async removeActiveGoal(userId: string, goal: string): Promise<void> {
    const current = await this.get(userId);
    await this.update(userId, {
      activeGoals: current.activeGoals.filter((g) => g !== goal),
    });
  }

  /**
   * Update preferences
   */
  async updatePreferences(userId: string, preferences: Partial<UserPreferences>): Promise<void> {
    const current = await this.get(userId);
    await this.update(userId, {
      preferences: { ...current.preferences, ...preferences },
    });
  }

  /**
   * Clear context (reset to defaults)
   */
  async clear(userId: string): Promise<void> {
    const key = this.getKey(userId);
    await this.storage.set(key, createDefaultContext());
  }
}
