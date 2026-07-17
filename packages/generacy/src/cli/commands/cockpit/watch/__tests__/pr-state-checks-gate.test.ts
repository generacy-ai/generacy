import { describe, expect, it } from 'vitest';
import { derivePrChecksNeeded } from '../pr-state.js';
import type { ChecksRollup, PrLifecycle, PrSnapshot } from '../snapshot.js';

function prev(
  overrides: Partial<PrSnapshot> & Pick<PrSnapshot, 'lifecycle' | 'checksRollup'>,
): PrSnapshot {
  return {
    kind: 'pr',
    repo: 'o/r',
    number: 1,
    url: 'https://github.com/o/r/pull/1',
    state: 'OPEN',
    stateReason: null,
    labels: [],
    classified: { state: 'agent-working', tier: 1, tags: [] } as unknown as PrSnapshot['classified'],
    cyclesSinceLastCheckFetch: 0,
    ...overrides,
  };
}

describe('derivePrChecksNeeded — decision matrix', () => {
  it('#1  no prev → fetch (no-prev)', () => {
    expect(
      derivePrChecksNeeded({
        prevSnapshot: undefined,
        currentLifecycle: 'open',
        currentLabels: [],
        currentHeadRefOid: undefined,
        cyclesSinceLastCheckFetch: 0,
      }),
    ).toEqual({ fetch: true, reason: 'no-prev' });
  });

  it('#2  currLifecycle=merged → skip (skip-terminal)', () => {
    expect(
      derivePrChecksNeeded({
        prevSnapshot: prev({ lifecycle: 'open', checksRollup: 'success' }),
        currentLifecycle: 'merged',
        currentLabels: [],
        currentHeadRefOid: 'a',
        cyclesSinceLastCheckFetch: 999,
      }),
    ).toEqual({ fetch: false, reason: 'skip-terminal' });
  });

  it('#3  currLifecycle=closed → skip (skip-terminal)', () => {
    expect(
      derivePrChecksNeeded({
        prevSnapshot: prev({ lifecycle: 'open', checksRollup: 'success' }),
        currentLifecycle: 'closed',
        currentLabels: [],
        currentHeadRefOid: 'a',
        cyclesSinceLastCheckFetch: 999,
      }),
    ).toEqual({ fetch: false, reason: 'skip-terminal' });
  });

  it('#4  prev=closed+success curr=open → lifecycle-flip', () => {
    expect(
      derivePrChecksNeeded({
        prevSnapshot: prev({ lifecycle: 'closed', checksRollup: 'success' }),
        currentLifecycle: 'open',
        currentLabels: [],
        currentHeadRefOid: 'a',
        cyclesSinceLastCheckFetch: 0,
      }),
    ).toEqual({ fetch: true, reason: 'lifecycle-flip' });
  });

  it.each<[ChecksRollup]>([['pending'], ['failure'], ['none'], ['error']])(
    '#5-8 prev=open+%s curr=open → not-terminal',
    (rollup) => {
      expect(
        derivePrChecksNeeded({
          prevSnapshot: prev({ lifecycle: 'open', checksRollup: rollup }),
          currentLifecycle: 'open',
          currentLabels: [],
          currentHeadRefOid: 'a',
          cyclesSinceLastCheckFetch: 0,
        }),
      ).toEqual({ fetch: true, reason: 'not-terminal' });
    },
  );

  it('#9  prev=open+success, head changed → head-changed', () => {
    expect(
      derivePrChecksNeeded({
        prevSnapshot: prev({
          lifecycle: 'open',
          checksRollup: 'success',
          headRefOid: 'a',
        }),
        currentLifecycle: 'open',
        currentLabels: [],
        currentHeadRefOid: 'b',
        cyclesSinceLastCheckFetch: 0,
      }),
    ).toEqual({ fetch: true, reason: 'head-changed' });
  });

  it('#10 prev=open+success, label added → label-changed', () => {
    expect(
      derivePrChecksNeeded({
        prevSnapshot: prev({
          lifecycle: 'open',
          checksRollup: 'success',
          headRefOid: 'a',
          labels: ['foo'],
        }),
        currentLifecycle: 'open',
        currentLabels: ['foo', 'bar'],
        currentHeadRefOid: 'a',
        cyclesSinceLastCheckFetch: 0,
      }),
    ).toEqual({ fetch: true, reason: 'label-changed' });
  });

  it('#11 prev=open+success, safety cycle → safety-cycle', () => {
    expect(
      derivePrChecksNeeded({
        prevSnapshot: prev({
          lifecycle: 'open',
          checksRollup: 'success',
          headRefOid: 'a',
        }),
        currentLifecycle: 'open',
        currentLabels: [],
        currentHeadRefOid: 'a',
        cyclesSinceLastCheckFetch: 20,
      }),
    ).toEqual({ fetch: true, reason: 'safety-cycle' });
  });

  it('#12 prev=open+success, steady → skip-terminal', () => {
    expect(
      derivePrChecksNeeded({
        prevSnapshot: prev({
          lifecycle: 'open',
          checksRollup: 'success',
          headRefOid: 'a',
        }),
        currentLifecycle: 'open',
        currentLabels: [],
        currentHeadRefOid: 'a',
        cyclesSinceLastCheckFetch: 5,
      }),
    ).toEqual({ fetch: false, reason: 'skip-terminal' });
  });

  it('#13 prev=open+success (no prev headOid), curr headOid missing → skip-terminal (I-5)', () => {
    expect(
      derivePrChecksNeeded({
        prevSnapshot: prev({ lifecycle: 'open', checksRollup: 'success' }),
        currentLifecycle: 'open',
        currentLabels: [],
        currentHeadRefOid: undefined,
        cyclesSinceLastCheckFetch: 0,
      }),
    ).toEqual({ fetch: false, reason: 'skip-terminal' });
  });

  it('label order does not matter (set equality)', () => {
    expect(
      derivePrChecksNeeded({
        prevSnapshot: prev({
          lifecycle: 'open',
          checksRollup: 'success',
          headRefOid: 'a',
          labels: ['x', 'y'],
        }),
        currentLifecycle: 'open',
        currentLabels: ['y', 'x'],
        currentHeadRefOid: 'a',
        cyclesSinceLastCheckFetch: 0,
      }),
    ).toEqual({ fetch: false, reason: 'skip-terminal' });
  });
});

// Ensure PrLifecycle union is exported / imports remain valid
const _lifecycles: PrLifecycle[] = ['open', 'closed', 'merged'];
void _lifecycles;
