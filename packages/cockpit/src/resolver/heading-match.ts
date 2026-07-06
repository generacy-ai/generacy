import { LoudResolverError } from './errors.js';
import type { ParsedEpicBody, ParsedPhase } from './types.js';

const DELIMITER_RE = /[\s—\-:,.\/]/;

/**
 * FR-005 first-token derivation: split on whitespace, em-dash, hyphen,
 * colon, comma, period, or slash; take the first non-empty token; lowercase.
 */
export function firstToken(heading: string): string {
  const parts = heading.split(DELIMITER_RE).filter((s) => s.length > 0);
  return (parts[0] ?? '').toLowerCase();
}

/**
 * Match `<phase>` against the parsed body's phase tokens.
 *
 * - 0 matches → `LoudResolverError('PHASE_NOT_FOUND', { candidateHeadings })`
 * - 1 match  → return the phase
 * - >1       → `LoudResolverError('AMBIGUOUS_PHASE_TOKEN', { candidateHeadings })`
 */
export function matchPhaseHeading(
  parsed: ParsedEpicBody,
  phaseArg: string,
): ParsedPhase {
  const needle = phaseArg.trim().toLowerCase();
  const matches = parsed.phases.filter((p) => p.token === needle);
  const candidateHeadings = parsed.phases.map((p) => p.heading);
  if (matches.length === 0) {
    throw new LoudResolverError('PHASE_NOT_FOUND', { candidateHeadings });
  }
  if (matches.length > 1) {
    throw new LoudResolverError('AMBIGUOUS_PHASE_TOKEN', {
      candidateHeadings: matches.map((p) => p.heading),
    });
  }
  return matches[0]!;
}
