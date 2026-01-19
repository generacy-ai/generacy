/**
 * Portability types for import/export
 * Based on data-model.md specification
 */

import type { Evidence, Philosophy, Pattern, UserContext } from './knowledge.js';

/**
 * Level of portability for export
 */
export type PortabilityLevel = 'full' | 'redacted' | 'abstracted';

/**
 * Exported principle with optional evidence
 */
export interface ExportedPrinciple {
  id: string;
  content: string;
  domain: string[];
  weight: number;
  evidenceCount: number;
  evidence?: Evidence[];
}

/**
 * Exported knowledge data
 */
export interface ExportedKnowledge {
  version: string;
  level: PortabilityLevel;
  exportedAt: string;
  philosophy?: Philosophy;
  principles?: ExportedPrinciple[];
  patterns?: Pattern[];
  context?: UserContext;
  checksum: string;
}

/**
 * Type of import conflict
 */
export type ConflictType = 'principle' | 'philosophy' | 'pattern';

/**
 * Resolution status for a conflict
 */
export type ConflictResolution = 'auto' | 'pending';

/**
 * A conflict detected during import
 */
export interface ImportConflict {
  type: ConflictType;
  existing: unknown;
  incoming: unknown;
  resolution: ConflictResolution;
  autoResolved?: boolean;
  reason?: string;
}

/**
 * Statistics about what was imported
 */
export interface ImportedStats {
  principles: number;
  patterns: number;
  philosophy: boolean;
}

/**
 * Statistics about what was merged
 */
export interface MergedStats {
  principles: number;
}

/**
 * Result of an import operation
 */
export interface ImportResult {
  success: boolean;
  imported: ImportedStats;
  merged: MergedStats;
  conflicts: ImportConflict[];
  errors: string[];
}

/**
 * Options for export operation
 */
export interface ExportOptions {
  level: PortabilityLevel;
  includeEvidence: boolean;
  anonymize: boolean;
}
