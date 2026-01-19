/**
 * Exporter - Export knowledge at different portability levels
 */

import { createHash } from 'node:crypto';
import type {
  Philosophy,
  Principle,
  Pattern,
  UserContext,
} from '../types/knowledge.js';
import type {
  ExportedKnowledge,
  PortabilityLevel,
} from '../types/portability.js';
import {
  transformPhilosophy,
  transformPrinciples,
  transformPatterns,
  transformContext,
} from './redaction.js';
import { now } from '../utils/timestamps.js';

/**
 * Current export format version
 */
const EXPORT_VERSION = '1.0.0';

/**
 * Generate checksum for exported data
 */
function generateChecksum(data: Omit<ExportedKnowledge, 'checksum'>): string {
  const content = JSON.stringify(data);
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Export knowledge at the specified portability level
 */
export function exportKnowledge(
  philosophy: Philosophy,
  principles: Principle[],
  patterns: Pattern[],
  context: UserContext,
  level: PortabilityLevel
): ExportedKnowledge {
  const transformedPhilosophy = transformPhilosophy(philosophy, level);
  const transformedPrinciples = transformPrinciples(principles, level);
  const transformedPatterns = transformPatterns(patterns, level);
  const transformedContext = transformContext(context, level);

  const exportData: Omit<ExportedKnowledge, 'checksum'> = {
    version: EXPORT_VERSION,
    level,
    exportedAt: now(),
    philosophy: transformedPhilosophy,
    principles: transformedPrinciples,
    patterns: transformedPatterns,
    context: transformedContext,
  };

  return {
    ...exportData,
    checksum: generateChecksum(exportData),
  };
}

/**
 * Verify export checksum
 */
export function verifyChecksum(data: ExportedKnowledge): boolean {
  const { checksum, ...rest } = data;
  const computed = generateChecksum(rest);
  return computed === checksum;
}
