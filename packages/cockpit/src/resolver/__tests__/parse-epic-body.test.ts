import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEpicBody } from '../parse-epic-body.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNIPLINK_BODY = readFileSync(join(HERE, 'fixtures', 'epic-826-sniplink.md'), 'utf-8');
const TETRAD_88_BODY = readFileSync(join(HERE, 'fixtures', 'epic-826-tetrad-88.md'), 'utf-8');

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
    expect(result.phases[0]!.refs).toEqual([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
      { repo: 'owner/repo', number: 3 },
      { repo: 'owner/other-repo', number: 4 },
    ]);

    expect(result.phases[1]!.heading).toBe('S3 — cleanup');
    expect(result.phases[1]!.token).toBe('s3');
    expect(result.phases[1]!.refs).toEqual([
      { repo: 'owner/repo', number: 5 },
      { repo: 'owner/repo', number: 1 },
    ]);

    // #935: refs after `####+` terminator are now collected as adhoc rather
    // than silently dropped, so #99 joins allRefs and adhocRefs.
    expect(result.adhocRefs).toEqual([{ repo: 'owner/repo', number: 99 }]);
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

  it('level-4 heading closes the current phase', () => {
    const body = [
      '### S1 alpha',
      '- [ ] owner/repo#1',
      '#### sub',
      '- [ ] owner/repo#2',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 1 }]);
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

  it('refs after a ####+ terminator become adhoc (#935)', () => {
    const body = [
      '### Phase 1',
      '- [ ] owner/repo#1',
      '#### notes',
      '- [ ] owner/repo#77',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 1 }]);
    expect(result.adhocRefs).toEqual([{ repo: 'owner/repo', number: 77 }]);
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
});
