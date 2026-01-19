/**
 * Redaction transforms for different portability levels
 */

import type {
  Philosophy,
  Principle,
  Pattern,
  UserContext,
} from '../types/knowledge.js';
import type { ExportedPrinciple, PortabilityLevel } from '../types/portability.js';

/**
 * Org-specific domains that should be redacted
 */
const ORG_SPECIFIC_PATTERNS = [
  /^company[:-]/i,
  /^org[:-]/i,
  /^internal[:-]/i,
  /^proprietary[:-]/i,
  /^confidential[:-]/i,
];

/**
 * Check if a domain is org-specific
 */
function isOrgSpecific(domain: string): boolean {
  return ORG_SPECIFIC_PATTERNS.some((pattern) => pattern.test(domain));
}

/**
 * Filter out org-specific domains
 */
function filterOrgDomains(domains: string[]): string[] {
  return domains.filter((d) => !isOrgSpecific(d));
}

/**
 * Transform philosophy for export
 */
export function transformPhilosophy(
  philosophy: Philosophy,
  level: PortabilityLevel
): Philosophy | undefined {
  if (level === 'abstracted') {
    // Anonymize identity
    return {
      values: philosophy.values,
      beliefs: philosophy.beliefs.map((b) => ({
        ...b,
        domain: filterOrgDomains(b.domain),
      })),
      identity: {},
    };
  }

  if (level === 'redacted') {
    // Remove org-specific domains from beliefs
    return {
      values: philosophy.values,
      beliefs: philosophy.beliefs.map((b) => ({
        ...b,
        domain: filterOrgDomains(b.domain),
      })),
      identity: philosophy.identity,
    };
  }

  // Full - return as-is
  return philosophy;
}

/**
 * Transform principles for export
 */
export function transformPrinciples(
  principles: Principle[],
  level: PortabilityLevel
): ExportedPrinciple[] {
  return principles
    .filter((p) => p.status !== 'deprecated')
    .map((p) => {
      const domains =
        level === 'full' ? p.domain : filterOrgDomains(p.domain);

      // Skip principles that are entirely org-specific
      if (domains.length === 0 && p.domain.length > 0) {
        return null;
      }

      const exported: ExportedPrinciple = {
        id: p.id,
        content: p.content,
        domain: domains,
        weight: p.weight,
        evidenceCount: p.evidence.length,
      };

      if (level === 'full') {
        exported.evidence = p.evidence;
      } else if (level === 'redacted') {
        // Include evidence but redact context if it contains org info
        exported.evidence = p.evidence.map((e) => ({
          ...e,
          context: e.context.replace(/\b(company|org|internal)\b/gi, '[REDACTED]'),
        }));
      }
      // Abstracted - no evidence included

      return exported;
    })
    .filter((p): p is ExportedPrinciple => p !== null);
}

/**
 * Transform patterns for export
 */
export function transformPatterns(
  patterns: Pattern[],
  level: PortabilityLevel
): Pattern[] | undefined {
  if (level === 'abstracted') {
    // Don't include patterns in abstracted export
    return undefined;
  }

  return patterns
    .filter((p) => p.status !== 'rejected')
    .map((p) => {
      const domains =
        level === 'full' ? p.domain : filterOrgDomains(p.domain);

      if (domains.length === 0 && p.domain.length > 0) {
        return null;
      }

      if (level === 'redacted') {
        return {
          ...p,
          domain: domains,
          occurrences: p.occurrences.map((o) => ({
            ...o,
            context: o.context.replace(/\b(company|org|internal)\b/gi, '[REDACTED]'),
          })),
        };
      }

      return p;
    })
    .filter((p): p is Pattern => p !== null);
}

/**
 * Transform context for export
 */
export function transformContext(
  context: UserContext,
  level: PortabilityLevel
): UserContext | undefined {
  if (level === 'abstracted' || level === 'redacted') {
    // Don't include context in redacted or abstracted
    return undefined;
  }

  return context;
}
