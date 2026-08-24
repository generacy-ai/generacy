import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countTasks, evaluateTasksMd } from '../tasks-md-fallback.js';
import type { WorkerContext } from '../types.js';

function contextFor(checkoutPath: string, issueNumber: number): WorkerContext {
  return {
    checkoutPath,
    item: { issueNumber },
  } as unknown as WorkerContext;
}

async function writeTasksMd(checkoutPath: string, dirName: string, content: string): Promise<void> {
  const dir = path.join(checkoutPath, 'specs', dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'tasks.md'), content, 'utf8');
}

describe('countTasks grammar matrix (FR-007)', () => {
  it('counts an unchecked `- [ ]` line', () => {
    expect(countTasks('- [ ] T001 do a thing')).toEqual({ unchecked: 1, checked: 0, total: 1 });
  });

  it('counts a checked `- [x]` line', () => {
    expect(countTasks('- [x] T001 done')).toEqual({ unchecked: 0, checked: 1, total: 1 });
  });

  it('treats uppercase `- [X]` as checked', () => {
    expect(countTasks('- [X] T001 done')).toEqual({ unchecked: 0, checked: 1, total: 1 });
  });

  it('accepts `*` and `+` bullets', () => {
    expect(countTasks('* [ ] a\n+ [x] b')).toEqual({ unchecked: 1, checked: 1, total: 2 });
  });

  it('accepts leading whitespace (spaces and tabs)', () => {
    expect(countTasks('   - [ ] indented\n\t- [x] tabbed')).toEqual({
      unchecked: 1,
      checked: 1,
      total: 2,
    });
  });

  it('ignores a `## heading` line', () => {
    expect(countTasks('## Phase 1: Setup')).toEqual({ unchecked: 0, checked: 0, total: 0 });
  });

  it('ignores a non-space/x marker like `- [~]`', () => {
    expect(countTasks('- [~] partial')).toEqual({ unchecked: 0, checked: 0, total: 0 });
  });

  it('ignores a mid-prose bracket', () => {
    expect(countTasks('see the note [ ] in the middle')).toEqual({
      unchecked: 0,
      checked: 0,
      total: 0,
    });
  });

  it('returns all-zero for empty content', () => {
    expect(countTasks('')).toEqual({ unchecked: 0, checked: 0, total: 0 });
  });

  it('mixes checked and unchecked across many lines', () => {
    const content = ['- [x] T001', '- [x] T002', '- [ ] T003', '- [ ] T004', '- [ ] T005'].join(
      '\n',
    );
    expect(countTasks(content)).toEqual({ unchecked: 3, checked: 2, total: 5 });
  });
});

describe('evaluateTasksMd classification matrix', () => {
  let checkoutPath: string;

  beforeEach(async () => {
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-md-fallback-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
  });

  it('classifies the #26 fixture (T001–T011 checked / T012–T026 unchecked) as incomplete (SC-002)', async () => {
    const lines: string[] = [];
    for (let n = 1; n <= 11; n += 1) {
      lines.push(`- [x] T${String(n).padStart(3, '0')} done`);
    }
    for (let n = 12; n <= 26; n += 1) {
      lines.push(`- [ ] T${String(n).padStart(3, '0')} remaining`);
    }
    await writeTasksMd(checkoutPath, '26-some-slug', lines.join('\n'));

    const result = evaluateTasksMd(contextFor(checkoutPath, 26));

    expect(result).toEqual({ kind: 'incomplete', unchecked: 15, checked: 11, total: 26 });
  });

  it('classifies an all-checked tasks.md as complete', async () => {
    await writeTasksMd(checkoutPath, '42-feature', '- [x] T001\n- [x] T002');

    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result).toEqual({ kind: 'complete', unchecked: 0, checked: 2, total: 2 });
  });

  it('classifies a tasks.md with zero task lines as complete (Q4=A)', async () => {
    await writeTasksMd(checkoutPath, '42-feature', '# Tasks\n\nNo checkboxes here.');

    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result).toEqual({ kind: 'complete', unchecked: 0, checked: 0, total: 0 });
  });

  it('classifies a missing specs dir as unreadable (fail-open)', async () => {
    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result.kind).toBe('unreadable');
  });

  it('classifies a missing spec dir for the issue as unreadable', async () => {
    await writeTasksMd(checkoutPath, '99-other', '- [ ] T001');

    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result.kind).toBe('unreadable');
    if (result.kind === 'unreadable') {
      expect(result.reason).toContain('no spec dir for issue 42');
    }
  });

  it('classifies ambiguous spec dirs as unreadable', async () => {
    await writeTasksMd(checkoutPath, '42-first', '- [ ] T001');
    await writeTasksMd(checkoutPath, '42-second', '- [ ] T001');

    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result.kind).toBe('unreadable');
    if (result.kind === 'unreadable') {
      expect(result.reason).toContain('ambiguous');
    }
  });

  it('classifies a missing tasks.md (spec dir present) as unreadable', async () => {
    await fs.mkdir(path.join(checkoutPath, 'specs', '42-feature'), { recursive: true });

    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result.kind).toBe('unreadable');
    if (result.kind === 'unreadable') {
      expect(result.reason).toContain('tasks.md not readable');
    }
  });
});
