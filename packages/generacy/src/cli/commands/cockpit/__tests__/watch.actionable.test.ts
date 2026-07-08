import { describe, expect, it } from 'vitest';
import { isActionableLabel, isActionableSnapshot } from '../watch/actionable.js';
import {
  buildIssueSnapshot,
  buildPrSnapshot,
  type ChecksRollup,
} from '../watch/snapshot.js';

describe('isActionableLabel', () => {
  it.each([
    'waiting-for:clarification',
    'waiting-for:review',
    'waiting-for:anything',
    'completed:validate',
    'failed:test',
    'failed:build',
    'failed:anything',
    'needs:intervention',
    'agent:error',
  ])('returns true for %s', (label) => {
    expect(isActionableLabel(label)).toBe(true);
  });

  it.each([
    'completed:specify',
    'completed:plan',
    'completed:clarify',
    'completed:tasks',
    'phase:plan',
    'phase:implement',
    'agent:in-progress',
    'type:bug',
    'type:feat',
    '',
  ])('returns false for %s', (label) => {
    expect(isActionableLabel(label)).toBe(false);
  });
});

describe('isActionableSnapshot', () => {
  function issue(labels: string[]) {
    return buildIssueSnapshot(
      'o/r',
      { number: 1, url: 'https://github.com/o/r/issues/1', state: 'OPEN', labels },
      { state: 'unknown', sourceLabel: '', labels },
    );
  }

  function pr(labels: string[], rollup: ChecksRollup) {
    return buildPrSnapshot(
      'o/r',
      { number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN', labels },
      { state: 'unknown', sourceLabel: '', labels },
      'open',
      rollup,
    );
  }

  it('returns true for an issue with an actionable label', () => {
    expect(isActionableSnapshot(issue(['waiting-for:clarification']))).toBe(true);
  });

  it('returns true for an issue carrying both completed:specify AND waiting-for:clarification (label-scan, not classified state)', () => {
    expect(
      isActionableSnapshot(issue(['completed:specify', 'waiting-for:clarification'])),
    ).toBe(true);
  });

  it('returns false for an issue with only non-actionable labels', () => {
    expect(isActionableSnapshot(issue(['phase:plan', 'agent:in-progress']))).toBe(false);
  });

  it('returns false for an issue with no labels', () => {
    expect(isActionableSnapshot(issue([]))).toBe(false);
  });

  it('returns true for a PR with checksRollup: failure and no failed:* label', () => {
    expect(isActionableSnapshot(pr(['phase:implement'], 'failure'))).toBe(true);
  });

  it('returns false for a PR with checksRollup: failure guard branch does not fire for issues', () => {
    // issues cannot have checksRollup in the type system; guard covers PR-only branch.
    expect(isActionableSnapshot(issue(['phase:implement']))).toBe(false);
  });

  it('returns true for a snapshot with an actionable label and a non-failing rollup', () => {
    expect(isActionableSnapshot(pr(['waiting-for:review'], 'success'))).toBe(true);
  });

  it('returns false for a PR with only non-actionable labels and non-failing rollup', () => {
    expect(isActionableSnapshot(pr(['phase:implement'], 'pending'))).toBe(false);
    expect(isActionableSnapshot(pr(['phase:implement'], 'success'))).toBe(false);
  });

  it('#857: returns false for a PR with checksRollup: none and no actionable labels', () => {
    expect(isActionableSnapshot(pr(['phase:implement'], 'none'))).toBe(false);
  });

  it('#857: returns false for a PR with checksRollup: error and no actionable labels', () => {
    expect(isActionableSnapshot(pr(['phase:implement'], 'error'))).toBe(false);
  });

  it('#857: still returns true for a PR with checksRollup: failure (pin unchanged behavior)', () => {
    expect(isActionableSnapshot(pr(['phase:implement'], 'failure'))).toBe(true);
  });
});
