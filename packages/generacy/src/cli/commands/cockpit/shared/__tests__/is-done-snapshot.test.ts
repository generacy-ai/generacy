import { describe, expect, it } from 'vitest';
import { isDoneSnapshot } from '../is-done-snapshot.js';
import {
  buildIssueSnapshot,
  buildPrSnapshot,
  type ChecksRollup,
  type PrLifecycle,
} from '../../watch/snapshot.js';

function issueSnap(opts: {
  state: 'OPEN' | 'CLOSED';
  stateReason?: 'COMPLETED' | 'NOT_PLANNED' | null;
  labels?: string[];
}) {
  const labels = opts.labels ?? [];
  return buildIssueSnapshot(
    'o/r',
    {
      number: 1,
      url: 'https://github.com/o/r/issues/1',
      state: opts.state,
      stateReason: opts.stateReason ?? null,
      labels,
    },
    { state: 'unknown', sourceLabel: '', labels },
  );
}

function prSnap(opts: {
  state: 'OPEN' | 'CLOSED';
  lifecycle: PrLifecycle;
  rollup?: ChecksRollup;
}) {
  return buildPrSnapshot(
    'o/r',
    {
      number: 1,
      url: 'https://github.com/o/r/pull/1',
      state: opts.state,
      stateReason: null,
      labels: [],
    },
    { state: 'unknown', sourceLabel: '', labels: [] },
    opts.lifecycle,
    opts.rollup ?? 'pending',
  );
}

describe('isDoneSnapshot — closed dominates any label residue', () => {
  it('returns false for an open issue with no labels', () => {
    expect(isDoneSnapshot(issueSnap({ state: 'OPEN' }))).toBe(false);
  });

  it('returns false for an open issue carrying completed:validate', () => {
    expect(
      isDoneSnapshot(issueSnap({ state: 'OPEN', labels: ['completed:validate'] })),
    ).toBe(false);
  });

  it('returns true for a closed issue with no labels', () => {
    expect(isDoneSnapshot(issueSnap({ state: 'CLOSED' }))).toBe(true);
  });

  it('#873: returns true for a closed issue carrying completed:validate', () => {
    expect(
      isDoneSnapshot(issueSnap({ state: 'CLOSED', labels: ['completed:validate'] })),
    ).toBe(true);
  });

  it('returns true for a closed issue with stateReason COMPLETED', () => {
    expect(
      isDoneSnapshot(issueSnap({ state: 'CLOSED', stateReason: 'COMPLETED' })),
    ).toBe(true);
  });

  it('returns true for a closed issue with stateReason NOT_PLANNED', () => {
    expect(
      isDoneSnapshot(issueSnap({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })),
    ).toBe(true);
  });

  it('returns false for an open PR', () => {
    expect(isDoneSnapshot(prSnap({ state: 'OPEN', lifecycle: 'open' }))).toBe(false);
  });

  it('returns true for a closed/merged PR', () => {
    expect(isDoneSnapshot(prSnap({ state: 'CLOSED', lifecycle: 'merged' }))).toBe(true);
  });
});
