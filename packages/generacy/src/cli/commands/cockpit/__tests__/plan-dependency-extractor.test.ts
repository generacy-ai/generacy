/**
 * Table-driven tests for `extractPlanDependencies` (#864, contracts/plan-dependency-warning.md).
 *
 * Positive cases: every trigger verb, cross-repo mentions, wrapped mentions, dedup.
 * Negative cases: fenced code, inline code, no trigger verb.
 */
import { describe, it, expect } from 'vitest';
import { extractPlanDependencies } from '../plan-dependency-extractor.js';

const DEFAULT_OWNER = 'octocat';
const DEFAULT_REPO = 'sniplink';

describe('extractPlanDependencies', () => {
  it('extracts bare `#N` on a "must be merged first" line', () => {
    const md = 'This work depends: #2 must be merged first before implementing.';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs).toEqual([
      expect.objectContaining({
        owner: DEFAULT_OWNER,
        repo: DEFAULT_REPO,
        number: 2,
      }),
    ]);
  });

  it('extracts cross-repo `owner/repo#N` on a "depends on" line', () => {
    const md = 'This work depends on generacy-ai/cluster-base#42 to be merged first.';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs).toEqual([
      expect.objectContaining({
        owner: 'generacy-ai',
        repo: 'cluster-base',
        number: 42,
      }),
    ]);
  });

  it('extracts a reference wrapped across the following line', () => {
    const md = 'This depends on the sibling PR — see\n#123 which lands first.';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs).toEqual([
      expect.objectContaining({
        owner: DEFAULT_OWNER,
        repo: DEFAULT_REPO,
        number: 123,
      }),
    ]);
  });

  it('de-duplicates identical mentions across multiple trigger lines', () => {
    const md = [
      'depends on #7',
      'and also requires #7',
      'and again #7 (still the same one)',
    ].join('\n');
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    const sevens = refs.filter((r) => r.number === 7);
    expect(sevens).toHaveLength(1);
  });

  it('does NOT extract inside fenced code blocks', () => {
    const md = [
      'Normal text without triggers.',
      '```',
      'depends on #99 (should be ignored — inside fence)',
      '```',
    ].join('\n');
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs).toEqual([]);
  });

  it('does NOT extract references inside inline code', () => {
    const md = 'The following depends on `#42` in a code span (should be ignored).';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs).toEqual([]);
  });

  it('does NOT extract when trigger verb is absent', () => {
    const md = 'This mentions #3 but nothing triggers extraction.';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs).toEqual([]);
  });

  it('extracts on `blocked by` trigger', () => {
    const md = 'Currently blocked by #55 pending approval.';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs.some((r) => r.number === 55)).toBe(true);
  });

  it('extracts on `prerequisite` trigger', () => {
    const md = 'Prerequisite: #77 must land first.';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs.some((r) => r.number === 77)).toBe(true);
  });

  it('extracts on `extends` trigger', () => {
    const md = 'This extends #12 (does not replace it).';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs.some((r) => r.number === 12)).toBe(true);
  });

  it('extracts on `must merge first` trigger', () => {
    const md = 'The sibling PR must merge first: #9';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs.some((r) => r.number === 9)).toBe(true);
  });

  it('extracts on `depends-on` trigger (hyphenated variant)', () => {
    const md = 'depends-on: #11';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs.some((r) => r.number === 11)).toBe(true);
  });

  it('bounds originatingText to 120 characters', () => {
    const longPrefix = 'a'.repeat(200);
    const md = `${longPrefix} depends on #4 must be merged first`;
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.originatingText.length).toBeLessThanOrEqual(120);
  });

  it('preserves first-occurrence order across multiple deps', () => {
    const md = [
      'depends on octocat/foo#10',
      'and requires bar/baz#20',
      'and blocked by octocat/foo#30',
    ].join('\n');
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs.map((r) => `${r.owner}/${r.repo}#${r.number}`)).toEqual([
      'octocat/foo#10',
      'bar/baz#20',
      'octocat/foo#30',
    ]);
  });

  it('cross-repo mention does not also produce a bare-ref duplicate', () => {
    const md = 'depends on generacy-ai/cluster-base#42';
    const refs = extractPlanDependencies(md, DEFAULT_OWNER, DEFAULT_REPO);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.owner).toBe('generacy-ai');
    expect(refs[0]!.repo).toBe('cluster-base');
    expect(refs[0]!.number).toBe(42);
  });
});
