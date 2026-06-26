import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { parseEpicBody } from '../manifest/parse-epic-body.js';
import { isCockpitExit } from '../exit.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = readFileSync(join(here, 'fixtures', 'epic-cockpit-body.md'), 'utf-8');

describe('parseEpicBody', () => {
  it('parses the epic-cockpit-body fixture into 3 phases with the expected shape', () => {
    const result = parseEpicBody(FIXTURE);
    expect(result.plan).toBe('docs/epic-cockpit-plan.md');
    expect(result.phases).toHaveLength(3);
    expect(result.phases[0]).toEqual({
      index: 0,
      name: 'P0 — Foundation',
      tier: 'v1',
      issues: ['generacy-ai/generacy#786', 'generacy-ai/generacy#787'],
    });
    expect(result.phases[1]).toEqual({
      index: 3,
      name: 'P3 — Manifest',
      tier: 'v2',
      issues: ['generacy-ai/generacy#790', 'generacy-ai/generacy#791'],
    });
    expect(result.phases[2]).toEqual({
      index: 4,
      name: 'P4 — Hardening',
      tier: 'v3',
      issues: ['generacy-ai/generacy#792'],
    });
  });

  it('treats `- [ ]`, `- [x]`, and `-` bullets identically', () => {
    const body = [
      'Plan: docs/plan.md',
      '## P1 — Foo',
      '- [ ] owner/repo#1',
      '- [x] owner/repo#2',
      '- owner/repo#3',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases[0]!.issues).toEqual([
      'owner/repo#1',
      'owner/repo#2',
      'owner/repo#3',
    ]);
  });

  it('skips prose paragraphs interleaved between bullets', () => {
    const body = [
      'Plan: docs/plan.md',
      '### P1 — Foo',
      '',
      'Some intro prose for this phase.',
      '- owner/repo#1',
      '',
      'A paragraph in between explaining context.',
      '',
      '- owner/repo#2',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases[0]!.issues).toEqual(['owner/repo#1', 'owner/repo#2']);
  });

  it('deduplicates repeated issue refs within a phase, preserving first occurrence', () => {
    const body = [
      'Plan: docs/plan.md',
      '### P1 — Foo',
      '- owner/repo#1',
      '- owner/repo#2',
      '- owner/repo#1',
    ].join('\n');
    expect(parseEpicBody(body).phases[0]!.issues).toEqual([
      'owner/repo#1',
      'owner/repo#2',
    ]);
  });

  it('skips a heading that has no `P\\d+` token', () => {
    const body = [
      'Plan: docs/plan.md',
      '### Random Notes',
      '- owner/repo#1',
      '### P1 — Foo',
      '- owner/repo#2',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.issues).toEqual(['owner/repo#2']);
  });

  it('throws CockpitExit(2) when no `P\\d+` heading is present', () => {
    const body = [
      'Plan: docs/plan.md',
      '### Random Notes',
      '- owner/repo#1',
    ].join('\n');
    try {
      parseEpicBody(body);
      throw new Error('expected throw');
    } catch (err) {
      expect(isCockpitExit(err)).toBe(true);
      const e = err as Error & { code: number };
      expect(e.code).toBe(2);
      expect(e.message).toMatch(/no 'P\\d\+' phase headings/);
    }
  });

  describe('duplicate phase indices', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('keeps the first occurrence and warns to stderr', () => {
      const body = [
        'Plan: docs/plan.md',
        '### P3 — First',
        '- owner/repo#1',
        '### P3 — Second',
        '- owner/repo#99',
      ].join('\n');
      const result = parseEpicBody(body);
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.name).toBe('P3 — First');
      expect(result.phases[0]!.issues).toEqual(['owner/repo#1']);
      expect(warnSpy).toHaveBeenCalled();
      const msg = String(warnSpy.mock.calls[0]![0]);
      expect(msg).toMatch(/duplicate phase index P3/);
    });
  });
});
