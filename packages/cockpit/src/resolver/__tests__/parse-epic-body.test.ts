import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEpicBody } from '../parse-epic-body.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNIPLINK_BODY = readFileSync(join(HERE, 'fixtures', 'epic-826-sniplink.md'), 'utf-8');
const TETRAD_88_BODY = readFileSync(join(HERE, 'fixtures', 'epic-826-tetrad-88.md'), 'utf-8');
const SNAPPOLL_BODY = readFileSync(join(HERE, 'fixtures', 'epic-1006-snappoll.md'), 'utf-8');
const BARE_REFS_1014_BODY = readFileSync(
  join(HERE, 'fixtures', 'epic-1014-bare-refs.md'),
  'utf-8',
);

// Ground truth for fixtures/epic-826-sniplink.md (T003 — read the markdown).
const SNIPLINK_EXPECTED: Array<{ heading: string; refs: Array<{ repo: string; number: number }> }> = [
  {
    heading: 'S1 — planning',
    refs: [{ repo: 'christrudelpw/sniplink', number: 1 }],
  },
  {
    heading: 'S2 — scaffolding',
    refs: [
      { repo: 'christrudelpw/sniplink', number: 2 },
      { repo: 'christrudelpw/sniplink', number: 3 },
      { repo: 'christrudelpw/sniplink', number: 4 },
    ],
  },
  {
    heading: 'S3 — core features',
    refs: [
      { repo: 'christrudelpw/sniplink', number: 5 },
      { repo: 'christrudelpw/sniplink', number: 6 },
      { repo: 'christrudelpw/sniplink', number: 7 },
    ],
  },
  {
    heading: 'S4 — polish',
    refs: [
      { repo: 'christrudelpw/sniplink', number: 8 },
      { repo: 'christrudelpw/sniplink', number: 9 },
    ],
  },
];

// Ground truth for fixtures/epic-826-tetrad-88.md (T003 — read the markdown).
const TETRAD_88_EXPECTED: Array<{ heading: string; refs: Array<{ repo: string; number: number }> }> = [
  {
    heading: 'P0 — foundation (generacy)',
    refs: [{ repo: 'generacy-ai/generacy', number: 786 }],
  },
  {
    heading: 'P1 — core internals (generacy ∥ agency)',
    refs: [
      { repo: 'generacy-ai/generacy', number: 787 },
      { repo: 'generacy-ai/generacy', number: 788 },
      { repo: 'generacy-ai/generacy', number: 789 },
      { repo: 'generacy-ai/agency', number: 350 },
    ],
  },
  {
    heading: 'P2 — core commands → v1 (agency)',
    refs: [
      { repo: 'generacy-ai/agency', number: 351 },
      { repo: 'generacy-ai/agency', number: 352 },
      { repo: 'generacy-ai/agency', number: 353 },
      { repo: 'generacy-ai/agency', number: 354 },
      { repo: 'generacy-ai/agency', number: 355 },
    ],
  },
  {
    heading: 'P3 — pipeline verbs (generacy)',
    refs: [
      { repo: 'generacy-ai/generacy', number: 790 },
      { repo: 'generacy-ai/generacy', number: 791 },
    ],
  },
  {
    heading: 'P4 — pipeline commands → v2 (agency)',
    refs: [
      { repo: 'generacy-ai/agency', number: 356 },
      { repo: 'generacy-ai/agency', number: 357 },
      { repo: 'generacy-ai/agency', number: 358 },
      { repo: 'generacy-ai/agency', number: 359 },
    ],
  },
  {
    heading: 'P5 — polish → v3 (generacy ∥ agency)',
    refs: [
      { repo: 'generacy-ai/generacy', number: 792 },
      { repo: 'generacy-ai/generacy', number: 793 },
      { repo: 'generacy-ai/agency', number: 360 },
    ],
  },
  {
    heading: 'S1 — rev 3 simplification: deletions (filed 2026-07-02; parallel across repos)',
    refs: [
      { repo: 'generacy-ai/generacy', number: 805 },
      { repo: 'generacy-ai/tetrad-development', number: 87 },
    ],
  },
  {
    heading: 'S2 — single-source discovery',
    refs: [{ repo: 'generacy-ai/generacy', number: 806 }],
  },
  {
    heading: 'S3 — verb collapse',
    refs: [{ repo: 'generacy-ai/generacy', number: 807 }],
  },
  {
    heading: 'S4 — plugin rewrite + residue cleanup',
    refs: [
      { repo: 'generacy-ai/agency', number: 372 },
      { repo: 'generacy-ai/generacy', number: 810 },
      { repo: 'generacy-ai/tetrad-development', number: 90 },
    ],
  },
  {
    heading: 'S6 — plugin packaging (preview-channel delivery; filed 2026-07-06)',
    refs: [
      { repo: 'generacy-ai/agency', number: 374 },
      { repo: 'generacy-ai/generacy', number: 816 },
    ],
  },
  {
    heading: 'S7 — cluster delivery (hand-run; repo not monitored)',
    refs: [{ repo: 'generacy-ai/cluster-base', number: 69 }],
  },
  {
    heading: 'S5 — integration gate (human; runs LAST, after S7, on a fresh preview-channel cluster)',
    refs: [{ repo: 'generacy-ai/tetrad-development', number: 88 }],
  },
];

describe('parseEpicBody', () => {
  it('parses the quickstart mixed-shape body into two phases with sorted allRefs', () => {
    const body = [
      '## Overview',
      '',
      'Some prose.',
      '',
      '### S2 — single-source discovery',
      '- [ ] owner/repo#1',
      '- [x] [owner/repo#2](https://example.test)',
      '- [ ] [#3](https://github.com/owner/repo/issues/3)',
      '- [ ] https://github.com/owner/other-repo/issues/4',
      '',
      '#### notes',
      '- [ ] owner/repo#99',
      '',
      '### S3 — cleanup',
      '- [ ] owner/repo#5',
      '- [ ] owner/repo#1',
      '',
    ].join('\n');

    const result = parseEpicBody(body);
    expect(result.phases).toHaveLength(2);

    expect(result.phases[0]!.heading).toBe('S2 — single-source discovery');
    expect(result.phases[0]!.token).toBe('s2');
    // #1014 (FR-002): non-phase-shaped `#### notes` is transparent — `owner/repo#99`
    // continues to attribute to the S2 phase. adhocRefs stays empty here.
    expect(result.phases[0]!.refs).toEqual([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
      { repo: 'owner/repo', number: 3 },
      { repo: 'owner/other-repo', number: 4 },
      { repo: 'owner/repo', number: 99 },
    ]);

    expect(result.phases[1]!.heading).toBe('S3 — cleanup');
    expect(result.phases[1]!.token).toBe('s3');
    expect(result.phases[1]!.refs).toEqual([
      { repo: 'owner/repo', number: 5 },
      { repo: 'owner/repo', number: 1 },
    ]);

    expect(result.adhocRefs).toEqual([]);
    expect(result.allRefs).toEqual([
      { repo: 'owner/other-repo', number: 4 },
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
      { repo: 'owner/repo', number: 3 },
      { repo: 'owner/repo', number: 5 },
      { repo: 'owner/repo', number: 99 },
    ]);

    expect(result.warnings).toEqual([]);
  });

  it('#1014 (FR-002): non-phase-shaped level-4 heading is transparent (no phase close)', () => {
    const body = [
      '### S1 alpha',
      '- [ ] owner/repo#1',
      '#### sub',
      '- [ ] owner/repo#2',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.refs).toEqual([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
    ]);
    expect(result.adhocRefs).toEqual([]);
  });

  it('level-2 heading is ignored (does not open or close)', () => {
    const body = [
      '### S1 alpha',
      '- [ ] owner/repo#1',
      '## Overview',
      '- [ ] owner/repo#2',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.refs).toEqual([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
    ]);
  });

  it('within-phase dedup collapses duplicates', () => {
    const body = [
      '### S1',
      '- [ ] owner/repo#1',
      '- [x] owner/repo#1',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 1 }]);
  });

  it('across-phase dedup collapses duplicates in allRefs (Q2 A)', () => {
    const body = [
      '### S1',
      '- [ ] owner/repo#1',
      '### S2',
      '- [ ] owner/repo#1',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 1 }]);
    expect(result.phases[1]!.refs).toEqual([{ repo: 'owner/repo', number: 1 }]);
    expect(result.allRefs).toEqual([{ repo: 'owner/repo', number: 1 }]);
  });

  it('emits a warning for a bare #N shorthand line and does not error', () => {
    const body = [
      '### S1',
      '- [ ] #8',
      '- [ ] owner/repo#1',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 1 }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/ignored ref-shaped task-list line 2/);
    expect(result.warnings[0]).toContain("'#8'");
  });

  it('empty body returns { phases: [], adhocRefs: [], allRefs: [], warnings: [] }', () => {
    const result = parseEpicBody('');
    expect(result.phases).toEqual([]);
    expect(result.adhocRefs).toEqual([]);
    expect(result.allRefs).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('task-list items in the preamble (before first phase) become adhocRefs and appear in allRefs (#935)', () => {
    const body = [
      '- [ ] owner/repo#1',
      '### S1',
      '- [ ] owner/repo#2',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 2 }]);
    expect(result.adhocRefs).toEqual([{ repo: 'owner/repo', number: 1 }]);
    expect(result.allRefs).toEqual([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
    ]);
  });

  it('flat body (no ### headings) collects refs into adhocRefs and allRefs (#935)', () => {
    const body = ['- [ ] owner/repo#3', '- [ ] owner/repo#4'].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases).toEqual([]);
    expect(result.adhocRefs).toEqual([
      { repo: 'owner/repo', number: 3 },
      { repo: 'owner/repo', number: 4 },
    ]);
    expect(result.allRefs).toEqual([
      { repo: 'owner/repo', number: 3 },
      { repo: 'owner/repo', number: 4 },
    ]);
  });

  it('## Ad-hoc heading (case-insensitive) closes the current phase and collects following refs as adhoc (#935)', () => {
    const body = [
      '### Phase 1',
      '- [ ] owner/repo#1',
      '## Ad-hoc',
      '- [ ] owner/repo#9',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 1 }]);
    expect(result.adhocRefs).toEqual([{ repo: 'owner/repo', number: 9 }]);
    expect(result.allRefs).toEqual([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 9 },
    ]);
  });

  it('## AD-HOC and lowercase variants match case-insensitively (#935)', () => {
    const body = ['## AD-HOC', '- [ ] owner/repo#1'].join('\n');
    const result = parseEpicBody(body);
    expect(result.adhocRefs).toEqual([{ repo: 'owner/repo', number: 1 }]);
    const body2 = ['## ad-hoc', '- [ ] owner/repo#2'].join('\n');
    const r2 = parseEpicBody(body2);
    expect(r2.adhocRefs).toEqual([{ repo: 'owner/repo', number: 2 }]);
  });

  it('#1014 (FR-002): refs after a non-phase-shaped `####+` stay in the current phase (transparent H4)', () => {
    const body = [
      '### Phase 1',
      '- [ ] owner/repo#1',
      '#### notes',
      '- [ ] owner/repo#77',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.refs).toEqual([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 77 },
    ]);
    expect(result.adhocRefs).toEqual([]);
  });

  it('a ref that appears in both a phase and adhoc dedups in allRefs; each container keeps its own copy (#935 I-4)', () => {
    const body = [
      '### Phase 1',
      '- [ ] owner/repo#5',
      '## Ad-hoc',
      '- [ ] owner/repo#5',
    ].join('\n');
    const result = parseEpicBody(body);
    // Mirrors existing cross-phase behavior: each container lists the ref
    // once, and allRefs dedupes across the union.
    expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 5 }]);
    expect(result.adhocRefs).toEqual([{ repo: 'owner/repo', number: 5 }]);
    expect(result.allRefs).toEqual([{ repo: 'owner/repo', number: 5 }]);
  });

  it('adhoc refs dedup within adhoc (I-1)', () => {
    const body = ['- [ ] owner/repo#1', '- [x] owner/repo#1'].join('\n');
    const result = parseEpicBody(body);
    expect(result.adhocRefs).toEqual([{ repo: 'owner/repo', number: 1 }]);
    expect(result.allRefs).toEqual([{ repo: 'owner/repo', number: 1 }]);
  });

  // T004 (#826): titled house-style lines resolve for every accepted shape × both
  // primary delimiter styles. Pre-fix: every one of these fails because refText
  // (`ref + delimiter + title`) is passed to parseRef whose regexes are ^…$-anchored.
  it('accepts all 4 ref shapes × 2 primary delimiter styles with trailing titles (FR-002, FR-003)', () => {
    const body = [
      '### S1 — mixed',
      '- [ ] owner/repo#1 — bare, em-dash',
      '- [ ] owner/repo#2 - bare, ascii-hyphen',
      '- [ ] [owner/repo#3](https://x.test) — md-link-bare-label, em-dash',
      '- [ ] [owner/repo#4](https://x.test) - md-link-bare-label, ascii-hyphen',
      '- [ ] [#5](https://github.com/owner/repo/issues/5) — md-link-hash-label, em-dash',
      '- [ ] [#6](https://github.com/owner/repo/pull/6) - md-link-hash-label, ascii-hyphen',
      '- [ ] https://github.com/owner/repo/issues/7 — plain URL, em-dash',
      '- [ ] https://github.com/owner/repo/pull/8 - plain URL, ascii-hyphen',
    ].join('\n');

    const result = parseEpicBody(body);
    expect(result.warnings).toEqual([]);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.refs).toEqual([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
      { repo: 'owner/repo', number: 3 },
      { repo: 'owner/repo', number: 4 },
      { repo: 'owner/repo', number: 5 },
      { repo: 'owner/repo', number: 6 },
      { repo: 'owner/repo', number: 7 },
      { repo: 'owner/repo', number: 8 },
    ]);
  });

  // T005 (#826): verbatim sniplink snapshot (frozen at PR time — do not re-sync).
  // See fixtures/epic-826-sniplink.md. Covers SC-001.
  it('resolves the sniplink snapshot with no warnings (SC-001)', () => {
    const result = parseEpicBody(SNIPLINK_BODY);
    expect(result.warnings).toEqual([]);
    expect(result.phases).toHaveLength(SNIPLINK_EXPECTED.length);
    for (const [i, expected] of SNIPLINK_EXPECTED.entries()) {
      expect(result.phases[i]!.heading).toBe(expected.heading);
      expect(result.phases[i]!.refs).toEqual(expected.refs);
    }
  });

  // T006 (#826): verbatim tetrad-development#85 snapshot (frozen at PR time).
  // See fixtures/epic-826-tetrad-88.md. Covers SC-001, SC-002 pre-condition.
  it('resolves the tetrad-development#85 snapshot with no warnings (SC-001, SC-002)', () => {
    const result = parseEpicBody(TETRAD_88_BODY);
    expect(result.warnings).toEqual([]);
    expect(result.phases).toHaveLength(TETRAD_88_EXPECTED.length);
    for (const [i, expected] of TETRAD_88_EXPECTED.entries()) {
      expect(result.phases[i]!.heading).toBe(expected.heading);
      expect(result.phases[i]!.refs).toEqual(expected.refs);
    }
  });

  // T007 (#826): warning-family marker substrings. Each rejection carries a
  // documented marker per contracts/parser-behavior.md §Warnings. Tests assert
  // via toContain() so full wording stays free to evolve. Covers FR-005, SC-003.
  it("warns 'bare '#N'' for bare-#N lines (FR-005)", () => {
    const body = ['### S1', '- [ ] #8'].join('\n');
    const result = parseEpicBody(body);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/ignored ref-shaped task-list line \d+/);
    expect(result.warnings[0]).toContain("'#8'");
    expect(result.warnings[0]).toContain("bare '#N'");
  });

  it("warns 'titled but not ref-shaped' for titled malformed lines (FR-005)", () => {
    // First token 'owner/repo#' is ref-shaped-ish (matches REF_SHAPED_RE broadly)
    // but no ^…$-anchored ref-shape in ref-shapes.ts matches — reason marker fires.
    const body = ['### S1', '- [ ] owner/repo#0 — title'].join('\n');
    const result = parseEpicBody(body);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/ignored ref-shaped task-list line \d+/);
    expect(result.warnings[0]).toContain("'owner/repo#0 — title'");
    expect(result.warnings[0]).toContain('titled but not ref-shaped');
  });

  it("warns 'URL path not /(issues|pull)/N' for bad-path URLs (FR-005)", () => {
    const body = ['### S1', '- [ ] https://github.com/owner/repo/commit/abc123'].join('\n');
    const result = parseEpicBody(body);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/ignored ref-shaped task-list line \d+/);
    expect(result.warnings[0]).toContain("'https://github.com/owner/repo/commit/abc123'");
    expect(result.warnings[0]).toContain('URL path not /(issues|pull)/N');
  });

  // T008 (#826): prose lines whose first token is not ref-shaped never warn,
  // even if a ref-shaped token appears later. Covers FR-007, SC-004.
  it('does not warn on prose lines that mention a ref outside the first-token position (FR-007)', () => {
    const body = ['### S1', '- [ ] Do X, see owner/repo#5'].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases[0]!.refs).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  // T009 (#826): when the first token IS a ref, additional ref-shaped tokens
  // in the title portion are silently ignored. Covers FR-008.
  it('silently ignores additional refs in the title portion (FR-008)', () => {
    const body = ['### S1', '- [ ] owner/repo#1 — depends on owner/repo#2'].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 1 }]);
    expect(result.warnings).toEqual([]);
  });

  // #1006 (FR-009): LLM-authored epics that nest `####` phase headers under a
  // single `### Delivery phases` H3 silently route every child ref to
  // `__adhoc__`. The detector emits a stable-marker warning; the marker
  // substring `phase headers must be '###'` is contractual (SC-006).
  describe("H4 phase-header detector (#1006)", () => {
    const MARKER = "phase headers must be '###'";

    // #1014 (SC-001): the snappoll fixture is re-pinned. Phase-shaped `####`
    // headings now open flat-sibling phases carrying their child refs; the
    // `#1006` `phase headers must be '###'` warning no longer fires because
    // `phases.every(p.refs.length === 0)` is now false. Kept for regression:
    // the guard is intact; only the fixture's parse outcome changed.
    it('no longer fires on the snappoll fixture — #1014 rescues H4 phases (SC-001)', () => {
      const result = parseEpicBody(SNAPPOLL_BODY);
      expect(result.warnings.every((w) => !w.includes(MARKER))).toBe(true);
      // Five phases: `### Delivery phases` (empty) + P1/P2/P3/P4 (populated).
      expect(result.phases).toHaveLength(5);
      expect(result.phases[0]!.heading).toBe('Delivery phases');
      expect(result.phases[0]!.refs).toEqual([]);
      expect(result.phases[1]!.heading).toBe('P1 — Scaffold');
      expect(result.phases[1]!.refs).toEqual([
        { repo: 'christrudelpw/snappoll', number: 2 },
      ]);
      expect(result.phases[2]!.heading).toBe('P2 — Foundation');
      expect(result.phases[2]!.refs).toEqual([
        { repo: 'christrudelpw/snappoll', number: 3 },
        { repo: 'christrudelpw/snappoll', number: 4 },
      ]);
      expect(result.phases[3]!.heading).toBe('P3 — Core functionality');
      expect(result.phases[3]!.refs).toEqual([
        { repo: 'christrudelpw/snappoll', number: 5 },
        { repo: 'christrudelpw/snappoll', number: 6 },
        { repo: 'christrudelpw/snappoll', number: 7 },
        { repo: 'christrudelpw/snappoll', number: 8 },
      ]);
      expect(result.phases[4]!.heading).toBe('P4 — Polish & delivery');
      expect(result.phases[4]!.refs).toEqual([
        { repo: 'christrudelpw/snappoll', number: 9 },
        { repo: 'christrudelpw/snappoll', number: 10 },
        { repo: 'christrudelpw/snappoll', number: 11 },
        { repo: 'christrudelpw/snappoll', number: 12 },
        { repo: 'christrudelpw/snappoll', number: 13 },
      ]);
      expect(result.adhocRefs).toEqual([]);
      // #1014 (FR-012): mixed `###` + phase-shaped `####` → single warning.
      expect(
        result.warnings.filter((w) => w.includes('mixed phase heading levels')),
      ).toHaveLength(1);
    });

    // Q1=C false-positive gates: `#### Notes` / `#### Follow-ups` /
    // `#### Rephrase X` under a populated `###` phase must NOT fire.
    it('does not fire on `#### Notes` under a populated phase (Q1=C false-positive gate)', () => {
      const body = [
        '### S1 — planning',
        '- [ ] owner/repo#1',
        '#### Notes',
        '- [ ] owner/repo#2',
      ].join('\n');
      const result = parseEpicBody(body);
      expect(result.warnings.every((w) => !w.includes(MARKER))).toBe(true);
    });

    it('does not fire on `#### Follow-ups` under a populated phase (Q1=C false-positive gate)', () => {
      const body = [
        '### S1 — planning',
        '- [ ] owner/repo#1',
        '#### Follow-ups',
        '- [ ] owner/repo#2',
      ].join('\n');
      const result = parseEpicBody(body);
      expect(result.warnings.every((w) => !w.includes(MARKER))).toBe(true);
    });

    it('does not fire on `#### Rephrase the API` — `\\bphase\\b` word-boundary is load-bearing', () => {
      const body = [
        '### S1 — planning',
        '- [ ] owner/repo#1',
        '#### Rephrase the API',
        '- [ ] owner/repo#2',
      ].join('\n');
      const result = parseEpicBody(body);
      expect(result.warnings.every((w) => !w.includes(MARKER))).toBe(true);
    });

    // SC-002 vacuous-guard: flat-list bodies have `phases.length === 0`;
    // `phases.every(...)` is vacuously true. Guard (a) rules this out.
    it('does not fire on flat-list bodies (SC-002 vacuous-guard case, guard (a) load-bearing)', () => {
      const body = ['## Scope', '- [ ] owner/repo#1', '- [ ] owner/repo#2'].join('\n');
      const result = parseEpicBody(body);
      expect(result.phases).toHaveLength(0);
      expect(result.adhocRefs).toHaveLength(2);
      expect(result.warnings.every((w) => !w.includes(MARKER))).toBe(true);
    });

    // #1014 (FR-002): `#### Notes` is transparent, so `owner/repo#1` attributes
    // to Phase S1. The `#1006` warning still doesn't fire (guard (d) intact:
    // `sawPhaseShapedH4` is false because Notes isn't phase-shaped). Test kept
    // as a guard-(d) regression witness; assertions updated for the new
    // transparency semantics.
    it('does not fire when the only #### heading is not phase-shaped (guard (d) load-bearing)', () => {
      const body = ['### S1', '#### Notes', '- [ ] owner/repo#1'].join('\n');
      const result = parseEpicBody(body);
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 1 }]);
      expect(result.adhocRefs).toEqual([]);
      expect(result.warnings.every((w) => !w.includes(MARKER))).toBe(true);
    });

    // SC-006: marker substring must appear in exactly one warning-emission
    // site inside parse-epic-body.ts (no accidental duplicates elsewhere).
    it('marker substring appears in exactly one place in parse-epic-body.ts (SC-006)', () => {
      const source = readFileSync(join(HERE, '..', 'parse-epic-body.ts'), 'utf-8');
      const matches = source.match(/phase headers must be '###'/g) ?? [];
      expect(matches).toHaveLength(1);
    });
  });

  // #1014 (T050 / FR-001, FR-002): phase-shaped `####` headings open flat-sibling
  // phases and carry their child refs; non-phase-shaped `####` inside a phase is
  // transparent (child refs continue to attribute to the surrounding phase).
  describe('#1014 H4 promotion (US1)', () => {
    it('phase-shaped `#### P1 …` opens a phase and carries its refs (FR-001)', () => {
      const body = [
        '#### P1 — Scaffold',
        '- [ ] owner/repo#2',
        '',
        '#### P2 — Foundation',
        '- [ ] owner/repo#3',
        '- [ ] owner/repo#4',
      ].join('\n');
      const result = parseEpicBody(body);
      expect(result.phases).toHaveLength(2);
      expect(result.phases[0]!.heading).toBe('P1 — Scaffold');
      expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 2 }]);
      expect(result.phases[1]!.heading).toBe('P2 — Foundation');
      expect(result.phases[1]!.refs).toEqual([
        { repo: 'owner/repo', number: 3 },
        { repo: 'owner/repo', number: 4 },
      ]);
      expect(result.adhocRefs).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('phase-shaped `#### Phase 1: …` opens a phase (word-boundaried \\bphase\\b)', () => {
      const body = ['#### Phase 1: Kickoff', '- [ ] owner/repo#7'].join('\n');
      const result = parseEpicBody(body);
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.heading).toBe('Phase 1: Kickoff');
      expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 7 }]);
      expect(result.adhocRefs).toEqual([]);
    });

    it('non-phase-shaped `#### Notes` inside `### Phase 1` — following ref attributes to Phase 1 (FR-002)', () => {
      const body = [
        '### Phase 1',
        '- [ ] owner/repo#1',
        '#### Notes',
        '- [ ] owner/repo#2',
      ].join('\n');
      const result = parseEpicBody(body);
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.refs).toEqual([
        { repo: 'owner/repo', number: 1 },
        { repo: 'owner/repo', number: 2 },
      ]);
      expect(result.adhocRefs).toEqual([]);
    });

    it('non-phase-shaped `#### Notes` outside any open phase is a no-op (FR-002)', () => {
      const body = ['#### Notes', '- [ ] owner/repo#1'].join('\n');
      const result = parseEpicBody(body);
      expect(result.phases).toEqual([]);
      expect(result.adhocRefs).toEqual([{ repo: 'owner/repo', number: 1 }]);
    });
  });

  // #1014 (T051 / FR-012): mixed `###` + phase-shaped `####` — flat siblings +
  // exactly one warning with the stable marker substring.
  describe('#1014 mixed heading levels warning (US1)', () => {
    const MIXED_MARKER = 'mixed phase heading levels';

    it('body with both `### Phase 1` and `#### Phase 2` produces two flat siblings + exactly one mixed warning (FR-012)', () => {
      const body = [
        '### Phase 1',
        '- [ ] owner/repo#1',
        '#### Phase 2',
        '- [ ] owner/repo#2',
      ].join('\n');
      const result = parseEpicBody(body);
      expect(result.phases).toHaveLength(2);
      expect(result.phases[0]!.heading).toBe('Phase 1');
      expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 1 }]);
      expect(result.phases[1]!.heading).toBe('Phase 2');
      expect(result.phases[1]!.refs).toEqual([{ repo: 'owner/repo', number: 2 }]);
      expect(
        result.warnings.filter((w) => w.includes(MIXED_MARKER)),
      ).toHaveLength(1);
    });

    it('warning count is 1 regardless of how many phase-shaped headings appear (FR-012)', () => {
      const body = [
        '### Phase 1',
        '#### Phase 2',
        '### Phase 3',
        '#### P4',
        '#### P5',
      ].join('\n');
      const result = parseEpicBody(body);
      expect(
        result.warnings.filter((w) => w.includes(MIXED_MARKER)),
      ).toHaveLength(1);
    });

    it('body with only `###` phases does NOT emit the mixed warning', () => {
      const body = ['### Phase 1', '### Phase 2'].join('\n');
      const result = parseEpicBody(body);
      expect(
        result.warnings.some((w) => w.includes(MIXED_MARKER)),
      ).toBe(false);
    });

    it('body with only phase-shaped `####` phases does NOT emit the mixed warning', () => {
      const body = ['#### P1', '#### P2'].join('\n');
      const result = parseEpicBody(body);
      expect(
        result.warnings.some((w) => w.includes(MIXED_MARKER)),
      ).toBe(false);
    });
  });

  // #1014 (T052 / FR-004, FR-005): bare `#N` in checkbox items resolves under
  // `defaultRepo`; without options, today's rejection behavior is preserved.
  describe('#1014 bare `#N` in checkboxes under `defaultRepo` (US2)', () => {
    it('positive (FR-004): `- [ ] #223` with defaultRepo resolves to that repo, no warning', () => {
      const body = '- [ ] #223 body';
      const result = parseEpicBody(body, { defaultRepo: 'my-org/my-repo' });
      expect(result.adhocRefs).toEqual([{ repo: 'my-org/my-repo', number: 223 }]);
      expect(result.warnings).toEqual([]);
    });

    it('negative (FR-005): same body without options preserves the bare-#N warning', () => {
      const body = '- [ ] #223 body';
      const result = parseEpicBody(body);
      expect(result.adhocRefs).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("bare '#N'");
    });

    it('positive: bare `- [x] #8` in a phase resolves under defaultRepo', () => {
      const body = ['### S1', '- [x] #8'].join('\n');
      const result = parseEpicBody(body, { defaultRepo: 'o/r' });
      expect(result.phases[0]!.refs).toEqual([{ repo: 'o/r', number: 8 }]);
      expect(result.warnings).toEqual([]);
    });
  });

  // #1014 (T053 / FR-013): bare `#N` outside checkbox items is NOT scanned.
  // (T053 / FR-007): cross-repo qualified refs inside checkboxes stay qualified.
  describe('#1014 checkbox-only scope + qualified-ref preservation (US2)', () => {
    it('FR-013: bare `- #99` (plain bullet, no checkbox) produces no refs and no warnings', () => {
      const body = ['### S1', '- #99'].join('\n');
      const result = parseEpicBody(body, { defaultRepo: 'o/r' });
      expect(result.phases[0]!.refs).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('FR-013: bare `1. #99` (ordered list) produces no refs and no warnings', () => {
      const body = ['### S1', '1. #99'].join('\n');
      const result = parseEpicBody(body, { defaultRepo: 'o/r' });
      expect(result.phases[0]!.refs).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('FR-013: prose `see #99` (no bullet) produces no refs and no warnings', () => {
      const body = ['### S1', 'see #99'].join('\n');
      const result = parseEpicBody(body, { defaultRepo: 'o/r' });
      expect(result.phases[0]!.refs).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('FR-007: cross-repo qualified `other/other-repo#5` inside a checkbox stays qualified even under defaultRepo', () => {
      const body = ['### S1', '- [ ] other/other-repo#5'].join('\n');
      const result = parseEpicBody(body, { defaultRepo: 'scope/scope-repo' });
      expect(result.phases[0]!.refs).toEqual([
        { repo: 'other/other-repo', number: 5 },
      ]);
      expect(result.warnings).toEqual([]);
    });
  });

  // #1014 (T054 / FR-003): malformed defaultRepo → exactly one warning +
  // behaves as if the option were absent (bare `#N` inside checkbox rejected).
  describe('#1014 malformed `defaultRepo` fails safe (US2)', () => {
    const INVALID_MARKER = 'invalid defaultRepo';

    for (const raw of ['not-owner-repo', 'owner/repo/extra', '']) {
      it(`FR-003: defaultRepo='${raw}' emits exactly one warning + treats bare #N as unqualified`, () => {
        const body = ['### S1', '- [ ] #10'].join('\n');
        const result = parseEpicBody(body, { defaultRepo: raw });
        expect(
          result.warnings.filter((w) => w.includes(INVALID_MARKER)),
        ).toHaveLength(1);
        // With defaultRepo rejected, bare `#10` behaves as no-options → rejected.
        expect(result.phases[0]!.refs).toEqual([]);
        // Compare with no-options behavior: both should treat bare #10 identically.
        const noOpts = parseEpicBody(body);
        expect(result.phases[0]!.refs).toEqual(noOpts.phases[0]!.refs);
      });
    }
  });

  // #1014 (T061 / FR-009 / SC-001): `epic-1014-bare-refs.md` fixture — under
  // scope-repo defaultRepo, all bare `#N` in checkbox items resolve; without
  // options, they all warn.
  describe('#1014 fixture: epic-1014-bare-refs.md', () => {
    it('positive (with defaultRepo): 4 refs in phase 1 + 1 ref in phase 2 + no warnings', () => {
      const result = parseEpicBody(BARE_REFS_1014_BODY, {
        defaultRepo: 'scope/scope-repo',
      });
      expect(result.phases).toHaveLength(2);
      expect(result.phases[0]!.refs).toEqual([
        { repo: 'scope/scope-repo', number: 223 },
        { repo: 'scope/scope-repo', number: 224 },
        { repo: 'scope/scope-repo', number: 225 },
        { repo: 'other/other-repo', number: 226 },
      ]);
      expect(result.phases[1]!.refs).toEqual([
        { repo: 'scope/scope-repo', number: 227 },
      ]);
      expect(result.warnings).toEqual([]);
    });

    it('negative (without defaultRepo): 4 bare-#N warnings, bare refs collapse', () => {
      const result = parseEpicBody(BARE_REFS_1014_BODY);
      const bareWarnings = result.warnings.filter((w) =>
        w.includes("bare '#N'"),
      );
      expect(bareWarnings).toHaveLength(4);
      // Only the cross-repo qualified ref survives in phase 1.
      expect(result.phases[0]!.refs).toEqual([
        { repo: 'other/other-repo', number: 226 },
      ]);
      expect(result.phases[1]!.refs).toEqual([]);
    });
  });

  // #1014 (T072 / SC-005): direct `parseEpicBody(body)` (no options) behavior
  // is byte-identical to `parseEpicBody(body, undefined)`.
  describe('#1014 SC-005 byte-identical regression', () => {
    it('parseEpicBody(body) and parseEpicBody(body, undefined) deep-equal', () => {
      const body = [
        '## Overview',
        '',
        '### S1 — planning',
        '- [ ] owner/repo#1',
        '- [ ] owner/repo#2',
        '',
        '### S2',
        '- [ ] owner/repo#3',
        '',
        '## Ad-hoc',
        '- [ ] owner/repo#99',
      ].join('\n');
      const noOpts = parseEpicBody(body);
      const undefinedOpts = parseEpicBody(body, undefined);
      expect(undefinedOpts).toEqual(noOpts);
    });
  });
});
