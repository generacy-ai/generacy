import { describe, expect, it } from 'vitest';
import { computeTransitions, type CockpitEvent } from '../watch/diff.js';
import {
  buildIssueSnapshot,
  buildPrSnapshot,
  snapshotKey,
  type SnapshotMap,
} from '../watch/snapshot.js';

const ts = (): string => '2026-06-26T12:00:00.000Z';

function map(...entries: Array<[string, ReturnType<typeof buildIssueSnapshot> | ReturnType<typeof buildPrSnapshot>]>): SnapshotMap {
  return new Map(entries);
}

function issueSnap(opts: {
  number?: number;
  state?: 'OPEN' | 'CLOSED';
  labels?: string[];
  classifiedState?: 'pending' | 'active' | 'waiting' | 'error' | 'terminal' | 'unknown';
  sourceLabel?: string;
}) {
  const number = opts.number ?? 1;
  return buildIssueSnapshot(
    'o/r',
    {
      number,
      url: `https://github.com/o/r/issues/${number}`,
      state: opts.state ?? 'OPEN',
      labels: opts.labels ?? [],
    },
    {
      state: opts.classifiedState ?? 'unknown',
      sourceLabel: opts.sourceLabel ?? '',
      labels: opts.labels ?? [],
    },
  );
}

function prSnap(opts: {
  number?: number;
  state?: 'OPEN' | 'CLOSED';
  lifecycle?: 'open' | 'closed' | 'merged';
  labels?: string[];
  classifiedState?: 'pending' | 'active' | 'waiting' | 'error' | 'terminal' | 'unknown';
  sourceLabel?: string;
  rollup?: 'pending' | 'success' | 'failure';
}) {
  const number = opts.number ?? 1;
  return buildPrSnapshot(
    'o/r',
    {
      number,
      url: `https://github.com/o/r/pull/${number}`,
      state: opts.state ?? 'OPEN',
      labels: opts.labels ?? [],
    },
    {
      state: opts.classifiedState ?? 'unknown',
      sourceLabel: opts.sourceLabel ?? '',
      labels: opts.labels ?? [],
    },
    opts.lifecycle ?? 'open',
    opts.rollup ?? 'pending',
  );
}

describe('computeTransitions', () => {
  it('emits nothing on first poll (prev empty)', () => {
    const prev: SnapshotMap = new Map();
    const curr = map([snapshotKey('o/r', 'issue', 1), issueSnap({ number: 1 })]);
    expect(computeTransitions(prev, curr, ts)).toEqual([]);
  });

  it('emits nothing when a key is new (baseline establishment)', () => {
    const prev = map([snapshotKey('o/r', 'issue', 1), issueSnap({ number: 1 })]);
    const curr = map(
      [snapshotKey('o/r', 'issue', 1), issueSnap({ number: 1 })],
      [snapshotKey('o/r', 'issue', 2), issueSnap({ number: 2 })],
    );
    const events = computeTransitions(prev, curr, ts);
    expect(events).toEqual([]);
  });

  it('emits label-change when classified state flips', () => {
    const prev = map([
      snapshotKey('o/r', 'issue', 1),
      issueSnap({ classifiedState: 'pending', sourceLabel: 'workflow:speckit-feature' }),
    ]);
    const curr = map([
      snapshotKey('o/r', 'issue', 1),
      issueSnap({ classifiedState: 'active', sourceLabel: 'phase:plan' }),
    ]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject<Partial<CockpitEvent>>({
      event: 'label-change',
      from: 'pending',
      to: 'active',
      sourceLabel: 'phase:plan',
    });
  });

  it('emits issue-closed when issue state goes OPEN → CLOSED', () => {
    const prev = map([snapshotKey('o/r', 'issue', 1), issueSnap({ state: 'OPEN' })]);
    const curr = map([snapshotKey('o/r', 'issue', 1), issueSnap({ state: 'CLOSED' })]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('issue-closed');
    expect(events[0]?.to).toBe('terminal');
  });

  it('emits pr-merged when PR lifecycle flips to merged', () => {
    const prev = map([snapshotKey('o/r', 'pr', 1), prSnap({ lifecycle: 'open' })]);
    const curr = map([snapshotKey('o/r', 'pr', 1), prSnap({ lifecycle: 'merged', state: 'CLOSED' })]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('pr-merged');
  });

  it('emits pr-closed when PR lifecycle flips to closed (not merged)', () => {
    const prev = map([snapshotKey('o/r', 'pr', 1), prSnap({ lifecycle: 'open' })]);
    const curr = map([snapshotKey('o/r', 'pr', 1), prSnap({ lifecycle: 'closed', state: 'CLOSED' })]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('pr-closed');
  });

  it('emits pr-checks when checksRollup flips', () => {
    const prev = map([snapshotKey('o/r', 'pr', 1), prSnap({ rollup: 'pending' })]);
    const curr = map([snapshotKey('o/r', 'pr', 1), prSnap({ rollup: 'success' })]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('pr-checks');
  });

  it('emits multiple events in precedence order: label-change → lifecycle → pr-checks', () => {
    const prev = map([
      snapshotKey('o/r', 'pr', 1),
      prSnap({
        classifiedState: 'waiting',
        sourceLabel: 'waiting-for:plan-review',
        lifecycle: 'open',
        rollup: 'pending',
      }),
    ]);
    const curr = map([
      snapshotKey('o/r', 'pr', 1),
      prSnap({
        classifiedState: 'terminal',
        sourceLabel: 'phase:done',
        lifecycle: 'merged',
        rollup: 'success',
        state: 'CLOSED',
      }),
    ]);
    const events = computeTransitions(prev, curr, ts);
    expect(events.map((e) => e.event)).toEqual(['label-change', 'pr-merged', 'pr-checks']);
  });
});
