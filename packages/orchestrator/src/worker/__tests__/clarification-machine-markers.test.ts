/**
 * #976 T010 — Structural coverage for `MACHINE_MARKERS`,
 * `commentCarriesMachineMarker`, and `matchMachineMarker`.
 *
 * Contract: `specs/976-summary-clarification-answers/contracts/machine-markers.md`
 * §Structural test coverage.
 */
import { describe, it, expect } from 'vitest';
import {
  CLARIFICATION_QUESTION_MARKERS,
  MACHINE_MARKERS,
  commentCarriesMachineMarker,
  matchMachineMarker,
} from '../clarification-markers.js';

describe('#976 MACHINE_MARKERS structural invariants', () => {
  it('is a superset of CLARIFICATION_QUESTION_MARKERS (I-M5)', () => {
    for (const q of CLARIFICATION_QUESTION_MARKERS) {
      expect(MACHINE_MARKERS.includes(q)).toBe(true);
    }
  });

  it('has no entry that is a prefix of another entry (I-M6)', () => {
    for (const a of MACHINE_MARKERS) {
      for (const b of MACHINE_MARKERS) {
        if (a === b) continue;
        expect(a.startsWith(b)).toBe(false);
      }
    }
  });

  it('includes the answer-relay marker `<!-- generacy-clarification-answers:` (Q2=A deprecation)', () => {
    expect(MACHINE_MARKERS.includes('<!-- generacy-clarification-answers:')).toBe(true);
  });
});

describe('#976 commentCarriesMachineMarker / matchMachineMarker', () => {
  it.each(MACHINE_MARKERS.map((m) => [m]))(
    'positively matches marker %s at column 0',
    (prefix) => {
      const body = `${prefix} -->\n\nQ1: something`;
      expect(commentCarriesMachineMarker(body)).toBe(true);
      expect(matchMachineMarker(body)).toBe(prefix);
    },
  );

  it('returns undefined for a `> `-quoted marker (column-0 rule, I-M2)', () => {
    const body = '> <!-- generacy-stage:clarification -->\n\nQ1: A';
    expect(commentCarriesMachineMarker(body)).toBe(false);
    expect(matchMachineMarker(body)).toBeUndefined();
  });

  it('returns undefined when the marker has leading whitespace (I-M2)', () => {
    expect(commentCarriesMachineMarker('  <!-- generacy-stage:planning -->')).toBe(false);
    expect(commentCarriesMachineMarker('\t<!-- generacy-clarifications:1 -->')).toBe(false);
    expect(matchMachineMarker('  <!-- generacy-stage:planning -->')).toBeUndefined();
  });

  it('returns undefined for marker-shaped prose without a `<!--` wrapper', () => {
    const body = 'here is some prose mentioning generacy-clarifications: which is not a marker\nQ1: A';
    expect(commentCarriesMachineMarker(body)).toBe(false);
    expect(matchMachineMarker(body)).toBeUndefined();
  });
});
