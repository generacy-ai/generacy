/**
 * @generacy-ai/knowledge-store
 *
 * Knowledge store management service for persisting and managing individual knowledge.
 */

import { KnowledgeStoreManager } from './manager/KnowledgeStoreManager.js';
import type { KnowledgeStoreConfig } from './types/storage.js';

// Re-export the main manager class
export { KnowledgeStoreManager } from './manager/KnowledgeStoreManager.js';

// Re-export input types
export type {
  CreatePrincipleInput,
  UpdatePrincipleInput,
  CreatePatternInput,
  UpdatePatternInput,
  VersionHistory,
} from './manager/KnowledgeStoreManager.js';

// Re-export core types
export type {
  // Knowledge types
  Value,
  Belief,
  Identity,
  Philosophy,
  Evidence,
  PrincipleStatus,
  PrincipleMetadata,
  Principle,
  PatternOccurrence,
  PatternStatus,
  Pattern,
  RecentDecision,
  CurrentProject,
  UserPreferences,
  UserContext,
  KnowledgeMetadata,
  IndividualKnowledge,
  // Storage types
  VersionInfo,
  StorageProvider,
  KnowledgeStoreConfig,
  // Portability types
  PortabilityLevel,
  ExportedPrinciple,
  ExportedKnowledge,
  ImportConflict,
  ImportResult,
  ExportOptions,
} from './types/index.js';

// Re-export storage classes for advanced usage
export { LocalFileStorage } from './storage/LocalFileStorage.js';
export { VersionedStorage } from './storage/VersionedStorage.js';
export { AuditableStorage, type AuditEntry } from './storage/AuditableStorage.js';
export { StorageError, KeyNotFoundError, VersionNotFoundError } from './storage/StorageProvider.js';

// Re-export validation utilities
export {
  validatePrinciple,
  validatePhilosophy,
  validatePattern,
  validateContext,
  type ValidationResult,
} from './validation/validator.js';

// Re-export portability utilities
export { exportKnowledge, verifyChecksum } from './portability/Exporter.js';
export { importKnowledge, applyImport } from './portability/Importer.js';

/**
 * Create a new knowledge store manager instance.
 *
 * @param config - Optional configuration
 * @returns A new KnowledgeStoreManager instance
 *
 * @example
 * ```typescript
 * import { createKnowledgeStore } from '@generacy-ai/knowledge-store';
 *
 * // Create with default configuration
 * const store = createKnowledgeStore();
 *
 * // Create with custom configuration
 * const store = createKnowledgeStore({
 *   baseDir: './my-knowledge',
 *   maxVersions: 100,
 *   enableAudit: true,
 * });
 *
 * // Use the store
 * const philosophy = await store.getPhilosophy('user-123');
 * await store.addPrinciple('user-123', {
 *   content: 'Always write tests',
 *   domain: ['coding'],
 * });
 * ```
 */
export function createKnowledgeStore(
  config?: KnowledgeStoreConfig
): KnowledgeStoreManager {
  return new KnowledgeStoreManager(config);
}
