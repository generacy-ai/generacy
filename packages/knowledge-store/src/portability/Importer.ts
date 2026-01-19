/**
 * Importer - Import knowledge with merge strategy and conflict detection
 */

import type { Principle, Pattern, Philosophy } from '../types/knowledge.js';
import type {
  ExportedKnowledge,
  ExportedPrinciple,
  ImportResult,
  ImportConflict,
} from '../types/portability.js';
import { verifyChecksum } from './Exporter.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/timestamps.js';

/**
 * High weight threshold for principles that need user review
 */
const HIGH_WEIGHT_THRESHOLD = 0.8;

/**
 * Check if two principles are similar (potential conflict)
 */
function arePrinciplesSimilar(a: Principle, b: ExportedPrinciple): boolean {
  // Same ID is always a conflict
  if (a.id === b.id) return true;

  // Similar content is a potential conflict
  const aWords = new Set(a.content.toLowerCase().split(/\s+/));
  const bWords = new Set(b.content.toLowerCase().split(/\s+/));
  const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
  const similarity = intersection.size / Math.max(aWords.size, bWords.size);

  return similarity > 0.7;
}

/**
 * Determine if a conflict can be auto-resolved
 */
function canAutoResolve(
  _existing: Principle | Philosophy | Pattern,
  incoming: ExportedPrinciple | Philosophy | Pattern
): { auto: boolean; reason?: string } {
  // High-weight principles need user review
  if ('weight' in incoming && incoming.weight >= HIGH_WEIGHT_THRESHOLD) {
    return { auto: false, reason: 'High-weight principle requires review' };
  }

  // Philosophy changes always need review
  if ('values' in incoming) {
    return { auto: false, reason: 'Philosophy changes require review' };
  }

  // Low-weight principles can be auto-merged
  if ('weight' in incoming && incoming.weight < 0.5) {
    return { auto: true, reason: 'Low-weight principle auto-merged' };
  }

  // Default to auto-resolve for simple cases
  return { auto: true, reason: 'Auto-merged based on default rules' };
}

/**
 * Convert exported principle to full principle
 */
function toFullPrinciple(exported: ExportedPrinciple): Principle {
  const timestamp = now();
  return {
    id: exported.id || generateId(),
    content: exported.content,
    domain: exported.domain,
    weight: exported.weight,
    evidence: exported.evidence ?? [],
    status: 'draft',
    metadata: {
      createdAt: timestamp,
      updatedAt: timestamp,
      source: 'imported',
    },
  };
}

/**
 * Import knowledge with merge strategy
 */
export function importKnowledge(
  existingPrinciples: Principle[],
  existingPatterns: Pattern[],
  existingPhilosophy: Philosophy,
  data: ExportedKnowledge
): ImportResult {
  const result: ImportResult = {
    success: true,
    imported: {
      principles: 0,
      patterns: 0,
      philosophy: false,
    },
    merged: {
      principles: 0,
    },
    conflicts: [],
    errors: [],
  };

  // Verify checksum
  if (!verifyChecksum(data)) {
    result.success = false;
    result.errors.push('Checksum verification failed');
    return result;
  }

  // Import principles
  if (data.principles) {
    const existingIds = new Set(existingPrinciples.map((p) => p.id));

    for (const incoming of data.principles) {
      // Check for ID collision
      if (existingIds.has(incoming.id)) {
        const existing = existingPrinciples.find((p) => p.id === incoming.id);
        if (existing) {
          const resolution = canAutoResolve(existing, incoming);
          const conflict: ImportConflict = {
            type: 'principle',
            existing,
            incoming,
            resolution: resolution.auto ? 'auto' : 'pending',
            autoResolved: resolution.auto,
            reason: resolution.reason,
          };
          result.conflicts.push(conflict);

          if (resolution.auto) {
            result.merged.principles++;
          }
        }
        continue;
      }

      // Check for similar content
      const similar = existingPrinciples.find((p) =>
        arePrinciplesSimilar(p, incoming)
      );

      if (similar) {
        const resolution = canAutoResolve(similar, incoming);
        const conflict: ImportConflict = {
          type: 'principle',
          existing: similar,
          incoming,
          resolution: resolution.auto ? 'auto' : 'pending',
          autoResolved: resolution.auto,
          reason: resolution.reason,
        };
        result.conflicts.push(conflict);

        if (resolution.auto) {
          result.merged.principles++;
        }
        continue;
      }

      // New principle - add it
      result.imported.principles++;
    }
  }

  // Import patterns
  if (data.patterns) {
    const existingPatternIds = new Set(existingPatterns.map((p) => p.id));

    for (const incoming of data.patterns) {
      if (!existingPatternIds.has(incoming.id)) {
        result.imported.patterns++;
      }
    }
  }

  // Import philosophy
  if (data.philosophy) {
    const hasExistingPhilosophy =
      existingPhilosophy.values.length > 0 ||
      existingPhilosophy.beliefs.length > 0;

    if (hasExistingPhilosophy) {
      const conflict: ImportConflict = {
        type: 'philosophy',
        existing: existingPhilosophy,
        incoming: data.philosophy,
        resolution: 'pending',
        autoResolved: false,
        reason: 'Existing philosophy requires manual merge decision',
      };
      result.conflicts.push(conflict);
    } else {
      result.imported.philosophy = true;
    }
  }

  // Mark as failed if there are unresolved conflicts
  const unresolvedConflicts = result.conflicts.filter(
    (c) => c.resolution === 'pending'
  );
  if (unresolvedConflicts.length > 0) {
    result.success = false;
  }

  return result;
}

/**
 * Apply import result to existing data
 * Returns the new principles and patterns to add
 */
export function applyImport(
  data: ExportedKnowledge,
  result: ImportResult
): { principles: Principle[]; patterns: Pattern[] } {
  const newPrinciples: Principle[] = [];
  const newPatterns: Pattern[] = [];

  if (data.principles && result.imported.principles > 0) {
    // Add principles that weren't conflicts
    const conflictIds = new Set(
      result.conflicts
        .filter((c) => c.type === 'principle')
        .map((c) => (c.incoming as ExportedPrinciple).id)
    );

    for (const p of data.principles) {
      if (!conflictIds.has(p.id)) {
        newPrinciples.push(toFullPrinciple(p));
      }
    }
  }

  if (data.patterns && result.imported.patterns > 0) {
    for (const p of data.patterns) {
      newPatterns.push(p);
    }
  }

  return { principles: newPrinciples, patterns: newPatterns };
}
