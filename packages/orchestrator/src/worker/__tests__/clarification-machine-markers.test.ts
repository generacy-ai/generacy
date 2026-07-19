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
  MACHINE_MARKER_FAMILIES,
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
  // #993: MACHINE_MARKERS entries that ALSO start with a MACHINE_MARKER_FAMILIES
  // prefix (only `<!-- generacy-stage:clarification` today) still match, but the
  // family match runs first and returns the family prefix. See
  // specs/993-summary-orchestrator-s/contracts/machine-markers-contract.md.
  const enumeratedOnly = MACHINE_MARKERS.filter(
    (m) => !MACHINE_MARKER_FAMILIES.some((f) => m.startsWith(f)),
  );
  const familySwept = MACHINE_MARKERS.filter((m) =>
    MACHINE_MARKER_FAMILIES.some((f) => m.startsWith(f)),
  );

  it.each(enumeratedOnly.map((m) => [m]))(
    'positively matches enumerated marker %s at column 0 (returns exact prefix)',
    (prefix) => {
      const body = `${prefix} -->\n\nQ1: something`;
      expect(commentCarriesMachineMarker(body)).toBe(true);
      expect(matchMachineMarker(body)).toBe(prefix);
    },
  );

  it.each(familySwept.map((m) => [m]))(
    'positively matches family-swept marker %s at column 0 (returns family prefix)',
    (prefix) => {
      const body = `${prefix} -->\n\nQ1: something`;
      const family = MACHINE_MARKER_FAMILIES.find((f) => prefix.startsWith(f))!;
      expect(commentCarriesMachineMarker(body)).toBe(true);
      expect(matchMachineMarker(body)).toBe(family);
    },
  );

  it('returns undefined for a `> `-quoted marker (column-0 rule, I-M2)', () => {
    const body = '> <!-- generacy-stage:clarification -->\n\nQ1: A';
    expect(commentCarriesMachineMarker(body)).toBe(false);
    expect(matchMachineMarker(body)).toBeUndefined();
  });

  it('returns undefined when the marker has leading whitespace (I-M2)', () => {
    expect(commentCarriesMachineMarker('  <!-- generacy-stage:foo -->')).toBe(false);
    expect(commentCarriesMachineMarker('\t<!-- generacy-clarifications:1 -->')).toBe(false);
    expect(matchMachineMarker('  <!-- generacy-stage:foo -->')).toBeUndefined();
  });

  it('returns undefined for marker-shaped prose without a `<!--` wrapper', () => {
    const body = 'here is some prose mentioning generacy-clarifications: which is not a marker\nQ1: A';
    expect(commentCarriesMachineMarker(body)).toBe(false);
    expect(matchMachineMarker(body)).toBeUndefined();
  });
});
