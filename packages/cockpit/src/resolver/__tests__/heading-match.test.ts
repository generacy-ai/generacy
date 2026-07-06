import { describe, expect, it } from 'vitest';
import { firstToken, matchPhaseHeading } from '../heading-match.js';
import { LoudResolverError } from '../errors.js';
import type { ParsedEpicBody, ParsedPhase } from '../types.js';

function phase(heading: string, refs: ParsedPhase['refs'] = []): ParsedPhase {
  return { heading, token: firstToken(heading), refs };
}

function body(phases: ParsedPhase[]): ParsedEpicBody {
  return { phases, allRefs: [], warnings: [] };
}

describe('firstToken', () => {
  it('lower-cases a bare token', () => {
    expect(firstToken('S2')).toBe('s2');
  });

  it('takes the first word before whitespace', () => {
    expect(firstToken('S2 — foo')).toBe('s2');
  });

  it('splits on em-dash', () => {
    expect(firstToken('S2—foo')).toBe('s2');
  });

  it('splits on hyphen', () => {
    expect(firstToken('S2-foo')).toBe('s2');
  });

  it('splits on colon', () => {
    expect(firstToken('S2: foo')).toBe('s2');
  });

  it('splits on period', () => {
    expect(firstToken('S2. foo')).toBe('s2');
  });

  it('splits on slash', () => {
    expect(firstToken('S2/foo')).toBe('s2');
  });

  it('splits on comma', () => {
    expect(firstToken('S2, foo')).toBe('s2');
  });

  it('skips leading whitespace', () => {
    expect(firstToken('   S2 foo')).toBe('s2');
  });

  it('returns empty string for empty input', () => {
    expect(firstToken('')).toBe('');
  });
});

describe('matchPhaseHeading', () => {
  it('returns the sole matching phase', () => {
    const parsed = body([phase('S2 — single-source'), phase('S3 — cleanup')]);
    const match = matchPhaseHeading(parsed, 's2');
    expect(match.heading).toBe('S2 — single-source');
  });

  it('is case-insensitive on the phase arg', () => {
    const parsed = body([phase('S2 — single-source')]);
    const match = matchPhaseHeading(parsed, 'S2');
    expect(match.token).toBe('s2');
  });

  it('throws PHASE_NOT_FOUND when no token matches', () => {
    const parsed = body([phase('S2 — single-source')]);
    try {
      matchPhaseHeading(parsed, 's9');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LoudResolverError);
      const loud = err as LoudResolverError;
      expect(loud.code).toBe('PHASE_NOT_FOUND');
      expect(loud.details).toEqual({
        candidateHeadings: ['S2 — single-source'],
      });
    }
  });

  it('throws AMBIGUOUS_PHASE_TOKEN when two headings share a first token', () => {
    const parsed = body([phase('S2 alpha'), phase('S2 beta')]);
    try {
      matchPhaseHeading(parsed, 's2');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LoudResolverError);
      const loud = err as LoudResolverError;
      expect(loud.code).toBe('AMBIGUOUS_PHASE_TOKEN');
      expect(loud.details).toEqual({
        candidateHeadings: ['S2 alpha', 'S2 beta'],
      });
    }
  });
});
