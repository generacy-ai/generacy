import { describe, expect, it } from 'vitest';
import { computeTransitions, type CockpitEvent } from '../watch/diff.js';
import {
  buildIssueSnapshot,
  buildPrSnapshot,
  snapshotKey,
  type ChecksRollup,
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
  rollup?: ChecksRollup;
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
  it('emits nothing on first poll when no snapshot is actionable', () => {
    const prev: SnapshotMap = new Map();
    const curr = map([
      snapshotKey('o/r', 'issue', 1),
      issueSnap({
        number: 1,
        labels: ['phase:plan', 'agent:in-progress'],
        classifiedState: 'active',
        sourceLabel: 'phase:plan',
      }),
    ]);
    expect(computeTransitions(prev, curr, ts)).toEqual([]);
  });

  it('emits an initial sweep line when an actionable label is present at first poll', () => {
    const prev: SnapshotMap = new Map();
    const curr = map([
      snapshotKey('o/r', 'issue', 1),
      issueSnap({
        number: 1,
        labels: ['waiting-for:clarification'],
        classifiedState: 'waiting',
        sourceLabel: 'waiting-for:clarification',
      }),
    ]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject<Partial<CockpitEvent>>({
      event: 'label-change',
      from: null,
      to: 'waiting',
      sourceLabel: 'waiting-for:clarification',
      initial: true,
    });
  });

  it('emits only actionable snapshots at first poll (mixed input)', () => {
    const prev: SnapshotMap = new Map();
    const curr = map(
      [
        snapshotKey('o/r', 'issue', 1),
        issueSnap({
          number: 1,
          labels: ['phase:plan'],
          classifiedState: 'active',
          sourceLabel: 'phase:plan',
        }),
      ],
      [
        snapshotKey('o/r', 'issue', 2),
        issueSnap({
          number: 2,
          labels: ['waiting-for:review'],
          classifiedState: 'waiting',
          sourceLabel: 'waiting-for:review',
        }),
      ],
    );
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]?.number).toBe(2);
    expect(events[0]?.initial).toBe(true);
  });

  it('emits an initial line for an issue carrying completed:specify AND waiting-for:clarification (SC-007 / Q2)', () => {
    const prev: SnapshotMap = new Map();
    const curr = map([
      snapshotKey('o/r', 'issue', 3),
      issueSnap({
        number: 3,
        labels: ['completed:specify', 'waiting-for:clarification'],
        // Simulates classifier's tier-precedence outcome (terminal beats waiting today).
        classifiedState: 'terminal',
        sourceLabel: 'completed:specify',
      }),
    ]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject<Partial<CockpitEvent>>({
      event: 'label-change',
      from: null,
      to: 'terminal',
      sourceLabel: 'completed:specify',
      initial: true,
    });
  });

  it('emits an initial line for a PR with checksRollup: failure and no failed:* label (SC-009 / Q5)', () => {
    const prev: SnapshotMap = new Map();
    const curr = map([
      snapshotKey('o/r', 'pr', 47),
      prSnap({
        number: 47,
        labels: ['phase:implement'],
        classifiedState: 'active',
        sourceLabel: 'phase:implement',
        rollup: 'failure',
      }),
    ]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject<Partial<CockpitEvent>>({
      event: 'label-change',
      from: null,
      to: 'active',
      sourceLabel: 'phase:implement',
      initial: true,
    });
    expect(events[0]?.kind).toBe('pr');
  });

  it('emits initial-sweep lines sorted by (repo, kind, number) — deterministic (SC-008)', () => {
    const prev: SnapshotMap = new Map();
    // Insert in reverse to prove sort is by key, not insertion order.
    const curr: SnapshotMap = new Map();
    curr.set(
      snapshotKey('o/r', 'pr', 5),
      buildPrSnapshot(
        'o/r',
        { number: 5, url: 'https://github.com/o/r/pull/5', state: 'OPEN', labels: ['waiting-for:review'] },
        { state: 'waiting', sourceLabel: 'waiting-for:review', labels: ['waiting-for:review'] },
        'open',
        'pending',
      ),
    );
    curr.set(
      snapshotKey('a/b', 'issue', 3),
      buildIssueSnapshot(
        'a/b',
        { number: 3, url: 'https://github.com/a/b/issues/3', state: 'OPEN', labels: ['waiting-for:clarification'] },
        { state: 'waiting', sourceLabel: 'waiting-for:clarification', labels: ['waiting-for:clarification'] },
      ),
    );
    curr.set(
      snapshotKey('a/b', 'pr', 1),
      buildPrSnapshot(
        'a/b',
        { number: 1, url: 'https://github.com/a/b/pull/1', state: 'OPEN', labels: ['waiting-for:review'] },
        { state: 'waiting', sourceLabel: 'waiting-for:review', labels: ['waiting-for:review'] },
        'open',
        'pending',
      ),
    );
    const events = computeTransitions(prev, curr, ts);
    expect(events.map((e) => `${e.repo}#${e.kind}#${e.number}`)).toEqual([
      'a/b#issue#3',
      'a/b#pr#1',
      'o/r#pr#5',
    ]);
  });

  it('polls 2..N never carry initial (SC-005 / FR-004)', () => {
    const prev = map([
      snapshotKey('o/r', 'issue', 1),
      issueSnap({ classifiedState: 'pending', sourceLabel: 'workflow:speckit-feature' }),
    ]);
    const curr = map([
      snapshotKey('o/r', 'issue', 1),
      issueSnap({ classifiedState: 'waiting', sourceLabel: 'waiting-for:clarification' }),
    ]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('initial');
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

  it('#857: emits pr-checks on prev pending → curr none transition', () => {
    const prev = map([snapshotKey('o/r', 'pr', 1), prSnap({ rollup: 'pending' })]);
    const curr = map([snapshotKey('o/r', 'pr', 1), prSnap({ rollup: 'none' })]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('pr-checks');
  });

  it('#857: emits pr-checks on prev none → curr success transition (repo gained CI mid-watch)', () => {
    const prev = map([snapshotKey('o/r', 'pr', 1), prSnap({ rollup: 'none' })]);
    const curr = map([snapshotKey('o/r', 'pr', 1), prSnap({ rollup: 'success' })]);
    const events = computeTransitions(prev, curr, ts);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('pr-checks');
  });

  it('#857: emits pr-checks on prev success → curr error transition (gh started failing)', () => {
    const prev = map([snapshotKey('o/r', 'pr', 1), prSnap({ rollup: 'success' })]);
    const curr = map([snapshotKey('o/r', 'pr', 1), prSnap({ rollup: 'error' })]);
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
