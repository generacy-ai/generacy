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
    expect(countTasks('- [ ] T001 do a thing')).toEqual({ unchecked: 1, checked: 0, total: 1, manual: 0 });
  });

  it('counts a checked `- [x]` line', () => {
    expect(countTasks('- [x] T001 done')).toEqual({ unchecked: 0, checked: 1, total: 1, manual: 0 });
  });

  it('treats uppercase `- [X]` as checked', () => {
    expect(countTasks('- [X] T001 done')).toEqual({ unchecked: 0, checked: 1, total: 1, manual: 0 });
  });

  it('accepts `*` and `+` bullets', () => {
    expect(countTasks('* [ ] a\n+ [x] b')).toEqual({ unchecked: 1, checked: 1, total: 2, manual: 0 });
  });

  it('accepts leading whitespace (spaces and tabs)', () => {
    expect(countTasks('   - [ ] indented\n\t- [x] tabbed')).toEqual({
      unchecked: 1,
      checked: 1,
      total: 2,
      manual: 0,
    });
  });

  it('ignores a `## heading` line', () => {
    expect(countTasks('## Phase 1: Setup')).toEqual({ unchecked: 0, checked: 0, total: 0, manual: 0 });
  });

  it('ignores a non-space/x marker like `- [~]`', () => {
    expect(countTasks('- [~] partial')).toEqual({ unchecked: 0, checked: 0, total: 0, manual: 0 });
  });

  it('ignores a mid-prose bracket', () => {
    expect(countTasks('see the note [ ] in the middle')).toEqual({
      unchecked: 0,
      checked: 0,
      total: 0,
      manual: 0,
    });
  });

  it('returns all-zero for empty content', () => {
    expect(countTasks('')).toEqual({ unchecked: 0, checked: 0, total: 0, manual: 0 });
  });

  it('mixes checked and unchecked across many lines', () => {
    const content = ['- [x] T001', '- [x] T002', '- [ ] T003', '- [ ] T004', '- [ ] T005'].join(
      '\n',
    );
    expect(countTasks(content)).toEqual({ unchecked: 3, checked: 2, total: 5, manual: 0 });
  });
});

describe('countTasks heading grammar matrix (SC-002)', () => {
  it('counts an unchecked `### T001 Description` heading', () => {
    expect(countTasks('### T001 Description')).toEqual({ unchecked: 1, checked: 0, total: 1, manual: 0 });
  });

  it('counts a checked `### T001 [DONE] Description` heading', () => {
    expect(countTasks('### T001 [DONE] Description')).toEqual({
      unchecked: 0,
      checked: 1,
      total: 1,
      manual: 0,
    });
  });

  it('counts `[DONE]` at any heading level 1–6', () => {
    const content = ['# T001 [DONE]', '## T002 [DONE]', '###### T003 [DONE]'].join('\n');
    expect(countTasks(content)).toEqual({ unchecked: 0, checked: 3, total: 3, manual: 0 });
  });

  it('treats `[DONE]` after the title as unchecked (Q2=B strict)', () => {
    expect(countTasks('### T001 Description [DONE]')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 0,
    });
  });

  it('treats a `[DONE]` mid-title as unchecked (Q2=B strict)', () => {
    expect(countTasks('### T005 Verify [DONE] rendering')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 0,
    });
  });

  it('rejects a range/summary heading (hyphen boundary, Q3=A)', () => {
    expect(countTasks('### T001-T026 remaining')).toEqual({ unchecked: 0, checked: 0, total: 0, manual: 0 });
  });

  it('rejects en-dash and em-dash range headings (Q3=A)', () => {
    expect(countTasks('### T001–T026 remaining')).toEqual({ unchecked: 0, checked: 0, total: 0, manual: 0 });
    expect(countTasks('### T001—T026 remaining')).toEqual({ unchecked: 0, checked: 0, total: 0, manual: 0 });
  });

  it('does not count non-anchored headings that merely mention a task ID', () => {
    const content = ['### Phase 3.1: T012', '### Task T001', '### Notes on T001'].join('\n');
    expect(countTasks(content)).toEqual({ unchecked: 0, checked: 0, total: 0, manual: 0 });
  });

  it('sums a mixed checkbox + heading file (FR-003)', () => {
    const content = [
      '- [x] T001 checkbox done',
      '- [ ] T002 checkbox remaining',
      '### T003 [DONE] heading done',
      '### T004 heading remaining',
    ].join('\n');
    expect(countTasks(content)).toEqual({ unchecked: 2, checked: 2, total: 4, manual: 0 });
  });
});

/**
 * #1214 manual classification. The two matrices above are the SC-005 regression
 * pin: their `unchecked` / `checked` / `total` expectations are unchanged, with
 * only the additive `manual: 0` field appended (the widened return type forces
 * that on `toEqual`).
 */
describe('countTasks manual marker tier (#1214, Q3=A)', () => {
  it('classifies a leading `[manual]` marker in checkbox grammar', () => {
    expect(countTasks('- [ ] T005 [manual] Verify the deploy')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 1,
    });
  });

  it('classifies a trailing `[manual]` marker (position-lenient, #2714)', () => {
    expect(countTasks('- [ ] T005 Verify the deploy end to end [manual]')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 1,
    });
  });

  it('classifies a `[manual]` marker in heading grammar', () => {
    expect(countTasks('### T005 Check dashboards [manual]')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 1,
    });
  });

  it('matches the marker case-insensitively', () => {
    expect(countTasks('- [ ] T005 [MANUAL] Verify\n- [ ] T006 [Manual] Verify')).toEqual({
      unchecked: 2,
      checked: 0,
      total: 2,
      manual: 2,
    });
  });

  it('counts a heading carrying both `[DONE]` and `[manual]` as checked, full stop', () => {
    expect(countTasks('### T001 [DONE] Verify flow [manual]')).toEqual({
      unchecked: 0,
      checked: 1,
      total: 1,
      manual: 0,
    });
  });

  it('counts a checked checkbox carrying `[manual]` as checked, full stop', () => {
    expect(countTasks('- [x] T001 [manual] Verify flow')).toEqual({
      unchecked: 0,
      checked: 1,
      total: 1,
      manual: 0,
    });
  });
});

describe('countTasks manual keyword tier (#1214, Q2=B)', () => {
  it('classifies `Manually verify …` (keyword at word 1, #2723)', () => {
    expect(countTasks('- [ ] T028 Manually verify the export flow')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 1,
    });
  });

  it('classifies `Hand-test the …` (keyword at word 1)', () => {
    expect(countTasks('- [ ] T029 Hand-test the retry path')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 1,
    });
  });

  it('classifies `Verify manually that …` (keyword at word 2)', () => {
    expect(countTasks('- [ ] T010 Verify manually that CI passes')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 1,
    });
  });

  it('classifies keyword-tier tasks in heading grammar too', () => {
    expect(countTasks('### T010 Manually verify the dashboard')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 1,
    });
  });

  it('does not classify a keyword outside the first 4 words', () => {
    expect(countTasks('- [ ] T012 rewrite the entire user manual section')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 0,
    });
  });

  it('does not classify `manuals` (whole-word rule)', () => {
    expect(countTasks('- [ ] T013 add manuals directory')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 0,
    });
  });

  it('does not classify ordinary automatable prose', () => {
    expect(countTasks('- [ ] T014 [US2] Add the two-tier detectors to tasks-md-fallback.ts')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 0,
    });
  });

  // ACCEPTED RESIDUAL FALSE POSITIVE (documented Q2=B trade-off, data-model.md).
  // "manual" lands at word 4 of the task text, inside the keyword window, so
  // this doc-writing task classifies manual. Deliberate: the classification
  // suppresses re-entry only when EVERY remaining unchecked task classifies
  // manual, and the result is a visible, operator-overridable pause rather than
  // a silent `failed:implement`. Do not "fix" this without revisiting Q2.
  it('classifies `update the user manual` as manual (accepted false positive)', () => {
    expect(countTasks('- [ ] T011 update the user manual')).toEqual({
      unchecked: 1,
      checked: 0,
      total: 1,
      manual: 1,
    });
  });
});

describe('countTasks manual counting invariance (SC-005)', () => {
  it('never shifts unchecked/checked/total when manual tasks are present', () => {
    const content = [
      '- [x] T001 checkbox done',
      '- [x] T002 [manual] checkbox done and gated',
      '- [ ] T003 checkbox automatable',
      '- [ ] T004 [manual] checkbox marker gated',
      '- [ ] T005 Manually verify the thing',
      '### T006 [DONE] heading done',
      '### T007 heading automatable',
      '### T008 heading gated [manual]',
      '### T009 Manually check the heading path',
    ].join('\n');

    const counts = countTasks(content);

    expect(counts).toEqual({ unchecked: 6, checked: 3, total: 9, manual: 4 });
    // Same file with every manual signal stripped: identical non-manual counts.
    const stripped = content.replaceAll(' [manual]', '').replaceAll('Manually', 'Programmatically');
    const strippedCounts = countTasks(stripped);
    expect(strippedCounts.unchecked).toBe(counts.unchecked);
    expect(strippedCounts.checked).toBe(counts.checked);
    expect(strippedCounts.total).toBe(counts.total);
    expect(strippedCounts.manual).toBe(0);
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

    expect(result).toEqual({
      kind: 'incomplete',
      unchecked: 15,
      automatable: 15,
      manual: 0,
      checked: 11,
      total: 26,
    });
  });

  it('classifies an all-checked tasks.md as complete', async () => {
    await writeTasksMd(checkoutPath, '42-feature', '- [x] T001\n- [x] T002');

    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result).toEqual({ kind: 'complete', unchecked: 0, checked: 2, total: 2 });
  });

  it('classifies a heading-grammar tasks.md with unfinished work as incomplete (SC-001)', async () => {
    await writeTasksMd(checkoutPath, '42-feature', '### T001 Description\n### T002 Another');

    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result).toEqual({
      kind: 'incomplete',
      unchecked: 2,
      automatable: 2,
      manual: 0,
      checked: 0,
      total: 2,
    });
  });

  it('classifies an all-DONE heading-grammar tasks.md as complete', async () => {
    await writeTasksMd(checkoutPath, '42-feature', '### T001 [DONE] Description');

    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result).toEqual({ kind: 'complete', unchecked: 0, checked: 1, total: 1 });
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

  it('classifies the #2723 remainder as manual-only (keyword tier, SC-009)', async () => {
    const content = [
      '- [x] T026 Wire the export endpoint',
      '- [x] T027 Add the unit tests',
      '- [ ] T028 Manually verify the export flow in the browser',
      '- [ ] T029 Manually walk the deploy checklist',
    ].join('\n');
    await writeTasksMd(checkoutPath, '2723-export-flow', content);

    const result = evaluateTasksMd(contextFor(checkoutPath, 2723));

    expect(result).toEqual({
      kind: 'manual-only',
      unchecked: 2,
      manual: 2,
      checked: 2,
      total: 4,
    });
  });

  it('classifies the #2714 remainder as manual-only (marker tier, SC-009)', async () => {
    const content = [
      '- [x] T029 Ship the change',
      '- [ ] T030 [manual] Browser verification of the new panel',
    ].join('\n');
    await writeTasksMd(checkoutPath, '2714-panel', content);

    const result = evaluateTasksMd(contextFor(checkoutPath, 2714));

    expect(result).toEqual({
      kind: 'manual-only',
      unchecked: 1,
      manual: 1,
      checked: 1,
      total: 2,
    });
  });

  it('classifies a mixed remainder as incomplete with the automatable/manual split', async () => {
    const content = [
      '- [x] T001 done',
      '- [ ] T002 add the retry guard',
      '- [ ] T003 [manual] verify the dashboard',
      '- [ ] T004 Manually walk the deploy checklist',
    ].join('\n');
    await writeTasksMd(checkoutPath, '42-feature', content);

    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result).toEqual({
      kind: 'incomplete',
      unchecked: 3,
      automatable: 1,
      manual: 2,
      checked: 1,
      total: 4,
    });
  });

  it('classifies an all-checked file with manual tasks as complete (no manual fields)', async () => {
    await writeTasksMd(
      checkoutPath,
      '42-feature',
      '- [x] T001 done\n- [x] T002 [manual] verified by hand',
    );

    const result = evaluateTasksMd(contextFor(checkoutPath, 42));

    expect(result).toEqual({ kind: 'complete', unchecked: 0, checked: 2, total: 2 });
  });
});
