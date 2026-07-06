import { describe, expect, it } from 'vitest';
import { parseEpicBody } from '../parse-epic-body.js';

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

    expect(result.allRefs).toEqual([
      { repo: 'owner/other-repo', number: 4 },
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
      { repo: 'owner/repo', number: 3 },
      { repo: 'owner/repo', number: 5 },
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

  it('empty body returns { phases: [], allRefs: [], warnings: [] }', () => {
    const result = parseEpicBody('');
    expect(result.phases).toEqual([]);
    expect(result.allRefs).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('task-list items outside a phase are ignored', () => {
    const body = [
      '- [ ] owner/repo#1',
      '### S1',
      '- [ ] owner/repo#2',
    ].join('\n');
    const result = parseEpicBody(body);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.refs).toEqual([{ repo: 'owner/repo', number: 2 }]);
  });
});
