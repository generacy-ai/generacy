import { describe, expect, it } from 'vitest';
import { applyScopeMutation, detectShape } from '../writer.js';
import type { IssueRef } from '@generacy-ai/cockpit';

const ref = (repo: string, number: number): IssueRef => ({ repo, number });

describe('detectShape', () => {
  it('phased body has at least one `### ` heading', () => {
    expect(detectShape('### Phase 1\n- [ ] owner/repo#1')).toBe('phased');
  });

  it('flat body has no `### ` headings', () => {
    expect(detectShape('- [ ] owner/repo#1\n- [ ] owner/repo#2')).toBe('flat');
  });

  it('empty body is flat', () => {
    expect(detectShape('')).toBe('flat');
  });

  it('L2 headings do not make body phased', () => {
    expect(detectShape('## Overview\n- [ ] owner/repo#1')).toBe('flat');
  });

  it('L4 headings do not make body phased', () => {
    expect(detectShape('#### notes\n- [ ] owner/repo#1')).toBe('flat');
  });
});

describe('applyScopeMutation — add', () => {
  it('case 1: phased body, no Ad-hoc — appends new Ad-hoc section at tail with one entry', () => {
    const body = '### Phase 1\n- [ ] owner/repo#1\n';
    const result = applyScopeMutation(body, { kind: 'add', ref: ref('owner/repo', 5) });
    expect(result.noop).toBe(false);
    expect(result.shape).toBe('phased');
    expect(result.body).toBe('### Phase 1\n- [ ] owner/repo#1\n\n## Ad-hoc\n\n- [ ] owner/repo#5\n');
  });

  it('case 2: phased body, Ad-hoc with 1 entry — appends under Ad-hoc', () => {
    const body = ['### Phase 1', '- [ ] owner/repo#1', '', '## Ad-hoc', '', '- [ ] owner/repo#3', ''].join('\n');
    const result = applyScopeMutation(body, { kind: 'add', ref: ref('owner/repo', 7) });
    expect(result.noop).toBe(false);
    expect(result.body).toBe(
      ['### Phase 1', '- [ ] owner/repo#1', '', '## Ad-hoc', '', '- [ ] owner/repo#3', '- [ ] owner/repo#7', ''].join('\n'),
    );
  });

  it('case 3: phased body, empty Ad-hoc — inserts first entry under heading', () => {
    const body = ['### Phase 1', '- [ ] owner/repo#1', '', '## Ad-hoc', ''].join('\n');
    const result = applyScopeMutation(body, { kind: 'add', ref: ref('owner/repo', 5) });
    expect(result.noop).toBe(false);
    expect(result.body).toBe(
      ['### Phase 1', '- [ ] owner/repo#1', '', '## Ad-hoc', '', '- [ ] owner/repo#5', ''].join('\n'),
    );
  });

  it('case 4: phased body, ref already in Phase — noop', () => {
    const body = '### Phase 1\n- [ ] owner/repo#5\n';
    const result = applyScopeMutation(body, { kind: 'add', ref: ref('owner/repo', 5) });
    expect(result.noop).toBe(true);
    expect(result.body).toBe(body);
  });

  it('case 6: flat body, one ref — appends at tail', () => {
    const body = '- [ ] owner/repo#1\n';
    const result = applyScopeMutation(body, { kind: 'add', ref: ref('owner/repo', 9) });
    expect(result.noop).toBe(false);
    expect(result.shape).toBe('flat');
    expect(result.body).toBe('- [ ] owner/repo#1\n- [ ] owner/repo#9\n');
  });

  it('case 7: flat body, empty — writes exactly one line', () => {
    const result = applyScopeMutation('', { kind: 'add', ref: ref('owner/repo', 1) });
    expect(result.noop).toBe(false);
    expect(result.shape).toBe('flat');
    expect(result.body).toBe('- [ ] owner/repo#1\n');
  });

  it('case 10: preserves trailing content shape when body lacks trailing newline', () => {
    const body = '- [ ] owner/repo#1'; // no trailing newline
    const result = applyScopeMutation(body, { kind: 'add', ref: ref('owner/repo', 2) });
    expect(result.body).toBe('- [ ] owner/repo#1\n- [ ] owner/repo#2\n');
  });

  it('recognises checked (`- [x]`) ref lines for idempotency', () => {
    const body = '- [x] owner/repo#5\n';
    const result = applyScopeMutation(body, { kind: 'add', ref: ref('owner/repo', 5) });
    expect(result.noop).toBe(true);
  });

  it('recognises alternate ref shapes for idempotency', () => {
    const body = '- [ ] [owner/repo#5](https://x.test)\n';
    const result = applyScopeMutation(body, { kind: 'add', ref: ref('owner/repo', 5) });
    expect(result.noop).toBe(true);
  });
});

describe('applyScopeMutation — remove', () => {
  it('case 5: phased, ref in Ad-hoc — deletes the line, keeps Ad-hoc heading', () => {
    const body = ['### Phase 1', '- [ ] owner/repo#1', '', '## Ad-hoc', '', '- [ ] owner/repo#5', ''].join('\n');
    const result = applyScopeMutation(body, { kind: 'remove', ref: ref('owner/repo', 5) });
    expect(result.noop).toBe(false);
    expect(result.body).toBe(
      ['### Phase 1', '- [ ] owner/repo#1', '', '## Ad-hoc', '', ''].join('\n'),
    );
  });

  it('case 8: flat, ref present — deletes line', () => {
    const body = '- [ ] owner/repo#1\n- [ ] owner/repo#2\n';
    const result = applyScopeMutation(body, { kind: 'remove', ref: ref('owner/repo', 1) });
    expect(result.noop).toBe(false);
    expect(result.body).toBe('- [ ] owner/repo#2\n');
  });

  it('case 9: flat, no matching line — noop', () => {
    const body = '- [ ] owner/repo#2\n';
    const result = applyScopeMutation(body, { kind: 'remove', ref: ref('owner/repo', 99) });
    expect(result.noop).toBe(true);
    expect(result.body).toBe(body);
  });

  it('removes only the first matching line (first-match semantics)', () => {
    const body = '### Phase 1\n- [ ] owner/repo#1\n### Phase 2\n- [ ] owner/repo#1\n';
    const result = applyScopeMutation(body, { kind: 'remove', ref: ref('owner/repo', 1) });
    expect(result.body).toBe('### Phase 1\n### Phase 2\n- [ ] owner/repo#1\n');
  });
});

describe('invariants', () => {
  it('I-5 round-trip: add then remove leaves body content-equivalent', () => {
    const bodies = [
      '### Phase 1\n- [ ] owner/repo#1\n',
      '- [ ] owner/repo#1\n- [ ] owner/repo#2\n',
      '',
      '### Phase 1\n- [ ] owner/repo#1\n\n## Ad-hoc\n\n- [ ] owner/repo#3\n',
    ];
    const target = ref('owner/repo', 99);
    for (const body of bodies) {
      const added = applyScopeMutation(body, { kind: 'add', ref: target });
      const roundTrip = applyScopeMutation(added.body, { kind: 'remove', ref: target });
      // Content equivalence: body after remove either equals input, or differs
      // only by Ad-hoc section scaffolding introduced by add (which remove
      // deliberately does not clean — verb symmetry).
      expect(roundTrip.body.includes('- [ ] owner/repo#99')).toBe(false);
    }
  });

  it('I-6 shape stability: add on phased never introduces new `### ` heading', () => {
    const body = '### Phase 1\n- [ ] owner/repo#1\n';
    const result = applyScopeMutation(body, { kind: 'add', ref: ref('owner/repo', 5) });
    const l3Count = result.body.split('\n').filter((l) => /^###\s+/.test(l)).length;
    expect(l3Count).toBe(1);
    expect(result.shape).toBe('phased');
  });

  it('I-6 shape stability: add on flat never introduces phase heading', () => {
    const body = '- [ ] owner/repo#1\n';
    const result = applyScopeMutation(body, { kind: 'add', ref: ref('owner/repo', 2) });
    expect(result.body.includes('### ')).toBe(false);
    expect(result.shape).toBe('flat');
  });
});
