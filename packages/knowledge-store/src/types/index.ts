/**
 * Type exports for Knowledge Store
 */

export type {
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
} from './knowledge.js';

export type {
  VersionInfo,
  StorageProvider,
  KnowledgeStoreConfig,
} from './storage.js';

export type {
  PortabilityLevel,
  ExportedPrinciple,
  ExportedKnowledge,
  ConflictType,
  ConflictResolution,
  ImportConflict,
  ImportedStats,
  MergedStats,
  ImportResult,
  ExportOptions,
} from './portability.js';
