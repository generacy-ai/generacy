/**
 * KnowledgeStoreManager - Facade for all knowledge operations
 */

import type {
  IndividualKnowledge,
  Philosophy,
  Principle,
  Pattern,
  UserContext,
} from '../types/knowledge.js';
import type { StorageProvider, VersionInfo, KnowledgeStoreConfig } from '../types/storage.js';
import type { ExportedKnowledge, ImportResult, PortabilityLevel } from '../types/portability.js';
import { LocalFileStorage } from '../storage/LocalFileStorage.js';
import { VersionedStorage } from '../storage/VersionedStorage.js';
import { exportKnowledge as exportKnowledgeFn } from '../portability/Exporter.js';
import { importKnowledge as importKnowledgeFn, applyImport } from '../portability/Importer.js';
import { PhilosophyManager } from './PhilosophyManager.js';
import { PrincipleManager, CreatePrincipleInput, UpdatePrincipleInput } from './PrincipleManager.js';
import { PatternManager, CreatePatternInput } from './PatternManager.js';
import { ContextManager } from './ContextManager.js';
import { now } from '../utils/timestamps.js';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<KnowledgeStoreConfig> = {
  baseDir: '.generacy/knowledge',
  maxVersions: 50,
  enableAudit: true,
};

/**
 * Version history entry
 */
export interface VersionHistory {
  philosophy: VersionInfo[];
  principles: VersionInfo[];
  patterns: VersionInfo[];
}

/**
 * Main facade for all knowledge store operations
 */
export class KnowledgeStoreManager {
  private readonly config: Required<KnowledgeStoreConfig>;
  private readonly storage: VersionedStorage;
  private readonly philosophyManager: PhilosophyManager;
  private readonly principleManager: PrincipleManager;
  private readonly patternManager: PatternManager;
  private readonly contextManager: ContextManager;

  constructor(config: KnowledgeStoreConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    const baseStorage = new LocalFileStorage(this.config.baseDir);
    this.storage = new VersionedStorage(baseStorage, {
      maxVersions: this.config.maxVersions,
    });

    this.philosophyManager = new PhilosophyManager(this.storage);
    this.principleManager = new PrincipleManager(this.storage);
    this.patternManager = new PatternManager(this.storage);
    this.contextManager = new ContextManager(this.storage);

    // Wire up pattern manager to principle manager for promotion
    this.patternManager.setPrincipleManager(this.principleManager);
  }

  // ==================== Aggregation ====================

  /**
   * Get complete knowledge for a user
   */
  async getKnowledge(userId: string): Promise<IndividualKnowledge> {
    const [philosophy, principles, patterns, context] = await Promise.all([
      this.philosophyManager.get(userId),
      this.principleManager.get(userId),
      this.patternManager.get(userId),
      this.contextManager.get(userId),
    ]);

    return {
      userId,
      philosophy,
      principles,
      patterns,
      context,
      metadata: {
        createdAt: now(),
        updatedAt: now(),
        version: 1,
      },
    };
  }

  // ==================== Philosophy Operations ====================

  /**
   * Get a user's philosophy
   */
  async getPhilosophy(userId: string): Promise<Philosophy> {
    return this.philosophyManager.get(userId);
  }

  /**
   * Update a user's philosophy
   */
  async updatePhilosophy(userId: string, update: Partial<Philosophy>): Promise<void> {
    return this.philosophyManager.update(userId, update);
  }

  // ==================== Principle Operations ====================

  /**
   * Get principles for a user, optionally filtered by domains
   */
  async getPrinciples(userId: string, domains?: string[]): Promise<Principle[]> {
    return this.principleManager.get(userId, domains);
  }

  /**
   * Add a new principle
   */
  async addPrinciple(userId: string, principle: CreatePrincipleInput): Promise<string> {
    return this.principleManager.add(userId, principle);
  }

  /**
   * Update a principle
   */
  async updatePrinciple(
    userId: string,
    principleId: string,
    update: UpdatePrincipleInput
  ): Promise<void> {
    return this.principleManager.update(userId, principleId, update);
  }

  /**
   * Deprecate a principle
   */
  async deprecatePrinciple(
    userId: string,
    principleId: string,
    reason: string
  ): Promise<void> {
    return this.principleManager.deprecate(userId, principleId, reason);
  }

  // ==================== Pattern Operations ====================

  /**
   * Get patterns for a user, optionally filtered by status
   */
  async getPatterns(userId: string, status?: Pattern['status']): Promise<Pattern[]> {
    return this.patternManager.get(userId, status);
  }

  /**
   * Add a new pattern
   */
  async addPattern(userId: string, pattern: CreatePatternInput): Promise<string> {
    return this.patternManager.add(userId, pattern);
  }

  /**
   * Promote a pattern to a principle
   */
  async promoteToAnciple(userId: string, patternId: string): Promise<string> {
    return this.patternManager.promoteToAnciple(userId, patternId);
  }

  // ==================== Context Operations ====================

  /**
   * Get a user's context
   */
  async getContext(userId: string): Promise<UserContext> {
    return this.contextManager.get(userId);
  }

  /**
   * Update a user's context
   */
  async updateContext(userId: string, update: Partial<UserContext>): Promise<void> {
    return this.contextManager.update(userId, update);
  }

  // ==================== Versioning ====================

  /**
   * Get version history for all stores
   */
  async getHistory(
    userId: string,
    store?: 'philosophy' | 'principles' | 'patterns'
  ): Promise<VersionHistory | VersionInfo[]> {
    if (store === 'philosophy') {
      return this.philosophyManager.getHistory(userId);
    }
    if (store === 'principles') {
      return this.principleManager.getHistory(userId);
    }
    if (store === 'patterns') {
      // Patterns don't have versioning by default, return empty
      return [];
    }

    // Return all histories
    const [philosophy, principles] = await Promise.all([
      this.philosophyManager.getHistory(userId),
      this.principleManager.getHistory(userId),
    ]);

    return {
      philosophy,
      principles,
      patterns: [],
    };
  }

  /**
   * Revert a store to a specific version
   */
  async revertTo(
    userId: string,
    store: 'philosophy' | 'principles',
    version: number
  ): Promise<void> {
    if (store === 'philosophy') {
      return this.philosophyManager.revertTo(userId, version);
    }
    throw new Error(`Revert not supported for store: ${store}`);
  }

  // ==================== Portability ====================

  /**
   * Export knowledge at specified portability level
   */
  async exportKnowledge(
    userId: string,
    level: PortabilityLevel
  ): Promise<ExportedKnowledge> {
    const [philosophy, principles, patterns, context] = await Promise.all([
      this.philosophyManager.get(userId),
      this.principleManager.get(userId),
      this.patternManager.get(userId),
      this.contextManager.get(userId),
    ]);

    return exportKnowledgeFn(philosophy, principles, patterns, context, level);
  }

  /**
   * Import knowledge with merge strategy
   */
  async importKnowledge(
    userId: string,
    data: ExportedKnowledge
  ): Promise<ImportResult> {
    const [existingPrinciples, existingPatterns, existingPhilosophy] = await Promise.all([
      this.principleManager.get(userId),
      this.patternManager.get(userId),
      this.philosophyManager.get(userId),
    ]);

    const result = importKnowledgeFn(
      existingPrinciples,
      existingPatterns,
      existingPhilosophy,
      data
    );

    // If import was successful or has only auto-resolved conflicts, apply changes
    if (result.success || result.conflicts.every((c) => c.autoResolved)) {
      const { principles, patterns } = applyImport(data, result);

      // Add new principles
      for (const principle of principles) {
        // Use internal storage to avoid validation (already validated during export)
        const key = `${userId}/principles`;
        const existing = await this.principleManager.get(userId);
        existing.push(principle);
        await this.storage.set(key, existing);
      }

      // Add new patterns
      for (const pattern of patterns) {
        const key = `${userId}/patterns`;
        const existing = await this.patternManager.get(userId);
        existing.push(pattern);
        await this.storage.set(key, existing);
      }

      // Import philosophy if indicated
      if (result.imported.philosophy && data.philosophy) {
        await this.philosophyManager.update(userId, data.philosophy);
      }
    }

    return result;
  }

  // ==================== Integrity ====================

  /**
   * Validate integrity of a user's knowledge store
   */
  async validateIntegrity(userId: string): Promise<{
    valid: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];

    const [philosophy, principles, patterns] = await Promise.all([
      this.philosophyManager.get(userId),
      this.principleManager.get(userId),
      this.patternManager.get(userId),
    ]);

    // Check for duplicate principle IDs
    const principleIds = new Set<string>();
    for (const p of principles) {
      if (principleIds.has(p.id)) {
        issues.push(`Duplicate principle ID: ${p.id}`);
      }
      principleIds.add(p.id);
    }

    // Check for duplicate pattern IDs
    const patternIds = new Set<string>();
    for (const p of patterns) {
      if (patternIds.has(p.id)) {
        issues.push(`Duplicate pattern ID: ${p.id}`);
      }
      patternIds.add(p.id);
    }

    // Check promoted patterns reference valid principles
    for (const pattern of patterns) {
      if (pattern.status === 'promoted' && pattern.promotedTo) {
        if (!principleIds.has(pattern.promotedTo)) {
          issues.push(
            `Pattern ${pattern.id} references non-existent principle ${pattern.promotedTo}`
          );
        }
      }
    }

    // Check value priorities are unique
    const priorities = new Set<number>();
    for (const value of philosophy.values) {
      if (priorities.has(value.priority)) {
        issues.push(`Duplicate value priority: ${value.priority}`);
      }
      priorities.add(value.priority);
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * Detect circular or conflicting principles
   */
  async detectCircularConflicts(userId: string): Promise<{
    hasConflicts: boolean;
    conflicts: Array<{ principle1: string; principle2: string; reason: string }>;
  }> {
    const principles = await this.principleManager.get(userId);
    const conflicts: Array<{ principle1: string; principle2: string; reason: string }> = [];

    // Simple heuristic: principles with opposite keywords
    const oppositePatterns = [
      ['always', 'never'],
      ['all', 'none'],
      ['must', 'must not'],
      ['should', 'should not'],
    ];

    for (let i = 0; i < principles.length; i++) {
      const p1 = principles[i]!;
      for (let j = i + 1; j < principles.length; j++) {
        const p2 = principles[j]!;

        // Check if they share domains
        const sharedDomains = p1.domain.filter((d) => p2.domain.includes(d));
        if (sharedDomains.length === 0) continue;

        // Check for opposite patterns
        const content1 = p1.content.toLowerCase();
        const content2 = p2.content.toLowerCase();

        for (const pair of oppositePatterns) {
          const word1 = pair[0]!;
          const word2 = pair[1]!;
          if (
            (content1.includes(word1) && content2.includes(word2)) ||
            (content1.includes(word2) && content2.includes(word1))
          ) {
            conflicts.push({
              principle1: p1.id,
              principle2: p2.id,
              reason: `Potentially conflicting guidance in domain: ${sharedDomains.join(', ')}`,
            });
            break;
          }
        }
      }
    }

    return {
      hasConflicts: conflicts.length > 0,
      conflicts,
    };
  }

  // ==================== Internal Access ====================

  /**
   * Get the underlying storage provider (for testing)
   */
  getStorage(): StorageProvider {
    return this.storage;
  }

  /**
   * Get individual managers (for advanced usage)
   */
  getManagers() {
    return {
      philosophy: this.philosophyManager,
      principles: this.principleManager,
      patterns: this.patternManager,
      context: this.contextManager,
    };
  }
}

// Re-export input types for convenience
export type { CreatePrincipleInput, UpdatePrincipleInput } from './PrincipleManager.js';
export type { CreatePatternInput, UpdatePatternInput } from './PatternManager.js';
