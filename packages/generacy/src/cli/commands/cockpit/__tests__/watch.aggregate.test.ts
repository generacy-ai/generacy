import { describe, expect, it } from 'vitest';
import type { IssueRef, ParsedEpicBody, ParsedPhase } from '@generacy-ai/cockpit';
import {
  computeAggregateEvents,
  initialAggregateState,
  type AggregateState,
} from '../watch/aggregate.js';
import {
  snapshotKey,
  type IssueSnapshot,
  type SnapshotMap,
} from '../watch/snapshot.js';
import type { AggregateEvent } from '../watch/aggregate-emit.js';

const EPIC_REPO = 'generacy-ai/generacy';
const EPIC_NUMBER = 885;

function ref(number: number, repo = EPIC_REPO): IssueRef {
  return { repo, number };
}

function phase(heading: string, token: string, refs: IssueRef[]): ParsedPhase {
  return { heading, token, refs };
}

function body(phases: ParsedPhase[], extraRefs: IssueRef[] = []): ParsedEpicBody {
  const seen = new Map<string, IssueRef>();
  for (const p of phases) {
    for (const r of p.refs) seen.set(`${r.repo}#${r.number}`, r);
  }
  for (const r of extraRefs) seen.set(`${r.repo}#${r.number}`, r);
  const allRefs = [...seen.values()].sort((a, b) => {
    const rc = a.repo.localeCompare(b.repo);
    return rc !== 0 ? rc : a.number - b.number;
  });
  return { phases, adhocRefs: [], allRefs, warnings: [] };
}

function issueSnap(
  repo: string,
  number: number,
  state: 'OPEN' | 'CLOSED',
): IssueSnapshot {
  return {
    kind: 'issue',
    repo,
    number,
    url: `https://github.com/${repo}/issues/${number}`,
    state,
    stateReason: state === 'CLOSED' ? 'COMPLETED' : null,
    labels: [],
    classified: { state: 'pending', sourceLabel: '', labels: [] },
  };
}

function makeMap(entries: IssueSnapshot[]): SnapshotMap {
  const m: SnapshotMap = new Map();
  for (const e of entries) m.set(snapshotKey(e.repo, 'issue', e.number), e);
  return m;
}

const TS = '2026-07-09T14:00:00.000Z';
const TS2 = '2026-07-09T14:05:00.000Z';

function makeNow(...values: string[]): () => string {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

function noPrevState(): AggregateState {
  return initialAggregateState();
}

describe('computeAggregateEvents — spec test cases', () => {
  it('last-merge-in-phase fires phase-complete exactly once; rerun with same curr emits nothing', () => {
    const p1 = phase('P1 — Foundation', 'p1', [ref(1), ref(2)]);
    const p2 = phase('P2 — Ship', 'p2', [ref(3), ref(4)]);
    const parsed = body([p1, p2]);
    const curr = makeMap([
      issueSnap(EPIC_REPO, 1, 'CLOSED'),
      issueSnap(EPIC_REPO, 2, 'CLOSED'),
      issueSnap(EPIC_REPO, 3, 'OPEN'),
      issueSnap(EPIC_REPO, 4, 'OPEN'),
    ]);
    const result = computeAggregateEvents({
      curr,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: noPrevState(),
      initial: false,
      now: makeNow(TS),
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe('phase-complete');
    if (result.events[0]?.type === 'phase-complete') {
      expect(result.events[0].phase).toBe('P1 — Foundation');
      expect(result.events[0].initial).toBeUndefined();
    }
    expect(result.nextState.seenCompletePhases.has('p1')).toBe(true);
    expect(result.nextState.seenCompletePhases.has('p2')).toBe(false);
    expect(result.nextState.epicComplete).toBe(false);

    const second = computeAggregateEvents({
      curr,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: result.nextState,
      initial: false,
      now: makeNow(TS2),
    });
    expect(second.events).toEqual([]);
  });

  it('mid-phase merge fires nothing', () => {
    const p1 = phase('P1', 'p1', [ref(1), ref(2), ref(3)]);
    const parsed = body([p1]);
    const curr = makeMap([
      issueSnap(EPIC_REPO, 1, 'CLOSED'),
      issueSnap(EPIC_REPO, 2, 'OPEN'),
      issueSnap(EPIC_REPO, 3, 'OPEN'),
    ]);
    const result = computeAggregateEvents({
      curr,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: noPrevState(),
      initial: false,
      now: makeNow(TS),
    });
    expect(result.events).toEqual([]);
  });

  it('reopen → regress → re-complete fires phase-complete twice with different ts', () => {
    const p1 = phase('P1', 'p1', [ref(1), ref(2)]);
    // Include an out-of-phase ref that stays OPEN so epic-complete does not fire.
    const parsed = body([p1], [ref(99)]);

    const closed = makeMap([
      issueSnap(EPIC_REPO, 1, 'CLOSED'),
      issueSnap(EPIC_REPO, 2, 'CLOSED'),
      issueSnap(EPIC_REPO, 99, 'OPEN'),
    ]);
    const first = computeAggregateEvents({
      curr: closed,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: noPrevState(),
      initial: false,
      now: makeNow(TS),
    });
    expect(first.events).toHaveLength(1);
    const firstEvt = first.events[0];
    expect(firstEvt?.type).toBe('phase-complete');
    expect(first.nextState.seenCompletePhases.has('p1')).toBe(true);

    // Regress: one ref reopens.
    const reopened = makeMap([
      issueSnap(EPIC_REPO, 1, 'CLOSED'),
      issueSnap(EPIC_REPO, 2, 'OPEN'),
      issueSnap(EPIC_REPO, 99, 'OPEN'),
    ]);
    const regress = computeAggregateEvents({
      curr: reopened,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: first.nextState,
      initial: false,
      now: makeNow(TS2),
    });
    expect(regress.events).toEqual([]);
    expect(regress.nextState.seenCompletePhases.has('p1')).toBe(false);

    // Re-complete
    const TS3 = '2026-07-09T14:10:00.000Z';
    const reclose = computeAggregateEvents({
      curr: closed,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: regress.nextState,
      initial: false,
      now: makeNow(TS3),
    });
    expect(reclose.events).toHaveLength(1);
    const reEvt = reclose.events[0];
    expect(reEvt?.type).toBe('phase-complete');
    if (reEvt?.type === 'phase-complete') {
      expect(reEvt.ts).toBe(TS3);
    }
    if (firstEvt?.type === 'phase-complete') {
      expect(firstEvt.ts).toBe(TS);
    }
  });

  it('no-phase issues excluded from phase-complete, included in epic-complete', () => {
    const p1 = phase('P1', 'p1', [ref(1), ref(2)]);
    // ref 3 is a "no phase" ref — not in any phase, but part of allRefs
    const parsed = body([p1], [ref(3)]);

    // Close P1 refs only
    const p1Closed = makeMap([
      issueSnap(EPIC_REPO, 1, 'CLOSED'),
      issueSnap(EPIC_REPO, 2, 'CLOSED'),
      issueSnap(EPIC_REPO, 3, 'OPEN'),
    ]);
    const first = computeAggregateEvents({
      curr: p1Closed,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: noPrevState(),
      initial: false,
      now: makeNow(TS),
    });
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.type).toBe('phase-complete');
    if (first.events[0]?.type === 'phase-complete') {
      expect(first.events[0].phase).toBe('P1');
    }
    expect(first.nextState.epicComplete).toBe(false);

    // Close remaining no-phase ref → epic-complete fires but no additional phase-complete
    const allClosed = makeMap([
      issueSnap(EPIC_REPO, 1, 'CLOSED'),
      issueSnap(EPIC_REPO, 2, 'CLOSED'),
      issueSnap(EPIC_REPO, 3, 'CLOSED'),
    ]);
    const second = computeAggregateEvents({
      curr: allClosed,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: first.nextState,
      initial: false,
      now: makeNow(TS2),
    });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.type).toBe('epic-complete');
    expect(second.nextState.epicComplete).toBe(true);
  });

  it('startup sweep marks phase-complete and epic-complete with initial: true', () => {
    const p1 = phase('P1', 'p1', [ref(1), ref(2)]);
    const parsed = body([p1]);
    const curr = makeMap([
      issueSnap(EPIC_REPO, 1, 'CLOSED'),
      issueSnap(EPIC_REPO, 2, 'CLOSED'),
    ]);
    const result = computeAggregateEvents({
      curr,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: noPrevState(),
      initial: true,
      now: makeNow(TS, TS2),
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.type).toBe('phase-complete');
    expect(result.events[0]?.initial).toBe(true);
    expect(result.events[1]?.type).toBe('epic-complete');
    expect(result.events[1]?.initial).toBe(true);
  });

  it('empty phase (refs.length === 0) never emits phase-complete but does not block epic-complete', () => {
    const p1 = phase('P1', 'p1', [ref(1)]);
    const p2Empty = phase('P2', 'p2', []);
    const parsed = body([p1, p2Empty]);
    const curr = makeMap([issueSnap(EPIC_REPO, 1, 'CLOSED')]);
    const result = computeAggregateEvents({
      curr,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: noPrevState(),
      initial: false,
      now: makeNow(TS, TS2),
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.type).toBe('phase-complete');
    if (result.events[0]?.type === 'phase-complete') {
      expect(result.events[0].phase).toBe('P1');
    }
    expect(result.events[1]?.type).toBe('epic-complete');
    // P2 empty phase never appears
    for (const evt of result.events) {
      if (evt.type === 'phase-complete') {
        expect(evt.phase).not.toBe('P2');
      }
    }
    expect(result.nextState.seenCompletePhases.has('p2')).toBe(false);
  });

  it('phase-less epic emits epic-complete and zero phase-complete events', () => {
    const parsed = body([], [ref(1), ref(2)]);
    const curr = makeMap([
      issueSnap(EPIC_REPO, 1, 'CLOSED'),
      issueSnap(EPIC_REPO, 2, 'CLOSED'),
    ]);
    const result = computeAggregateEvents({
      curr,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: noPrevState(),
      initial: false,
      now: makeNow(TS),
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe('epic-complete');
  });

  it('multiple simultaneous transitions ordered: P1 phase-complete, P2 phase-complete, epic-complete', () => {
    const p1 = phase('P1', 'p1', [ref(1)]);
    const p2 = phase('P2', 'p2', [ref(2)]);
    const parsed = body([p1, p2], [ref(3)]);
    const curr = makeMap([
      issueSnap(EPIC_REPO, 1, 'CLOSED'),
      issueSnap(EPIC_REPO, 2, 'CLOSED'),
      issueSnap(EPIC_REPO, 3, 'CLOSED'),
    ]);
    const result = computeAggregateEvents({
      curr,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: noPrevState(),
      initial: false,
      now: makeNow(TS, TS, TS),
    });
    expect(result.events.map((e) => e.type)).toEqual([
      'phase-complete',
      'phase-complete',
      'epic-complete',
    ]);
    const first = result.events[0];
    const second = result.events[1];
    if (first?.type === 'phase-complete') expect(first.phase).toBe('P1');
    if (second?.type === 'phase-complete') expect(second.phase).toBe('P2');
  });

  it('payload field discipline: emitted events omit forbidden per-issue fields', () => {
    const p1 = phase('P1', 'p1', [ref(1)]);
    const parsed = body([p1]);
    const curr = makeMap([issueSnap(EPIC_REPO, 1, 'CLOSED')]);
    const result = computeAggregateEvents({
      curr,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: noPrevState(),
      initial: false,
      now: makeNow(TS, TS2),
    });
    const forbidden = [
      'closedRefs',
      'totalCount',
      'suggestion',
      'repo',
      'kind',
      'number',
      'url',
      'labels',
      'sourceLabel',
      'from',
      'to',
      'event',
    ];
    for (const evt of result.events) {
      const record = evt as unknown as Record<string, unknown>;
      expect(record['epicRepo']).toBe(EPIC_REPO);
      expect(record['epicNumber']).toBe(EPIC_NUMBER);
      for (const key of forbidden) {
        expect(key in record).toBe(false);
      }
    }
  });

  it('does not mutate prevState (purity)', () => {
    const p1 = phase('P1', 'p1', [ref(1)]);
    const parsed = body([p1]);
    const curr = makeMap([issueSnap(EPIC_REPO, 1, 'CLOSED')]);
    const prev = noPrevState();
    const snapshot: AggregateState = {
      seenCompletePhases: new Set(prev.seenCompletePhases),
      epicComplete: prev.epicComplete,
    };
    computeAggregateEvents({
      curr,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: prev,
      initial: false,
      now: makeNow(TS, TS2),
    });
    expect(prev.epicComplete).toBe(snapshot.epicComplete);
    expect([...prev.seenCompletePhases]).toEqual([...snapshot.seenCompletePhases]);
  });

  it('PR-kind snapshots also count toward completeness', () => {
    const p1 = phase('P1', 'p1', [ref(1)]);
    const parsed = body([p1]);
    const currRaw = makeMap([]);
    // Insert as a PR snapshot
    currRaw.set(snapshotKey(EPIC_REPO, 'pr', 1), {
      kind: 'pr',
      repo: EPIC_REPO,
      number: 1,
      url: `https://github.com/${EPIC_REPO}/pull/1`,
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      labels: [],
      classified: { state: 'pending', sourceLabel: '', labels: [] },
      lifecycle: 'merged',
      checksRollup: 'success',
    });
    const result = computeAggregateEvents({
      curr: currRaw,
      parsed,
      epicRepo: EPIC_REPO,
      epicNumber: EPIC_NUMBER,
      prevState: noPrevState(),
      initial: false,
      now: makeNow(TS, TS2),
    });
    const types = result.events.map((e: AggregateEvent) => e.type);
    expect(types).toContain('phase-complete');
    expect(types).toContain('epic-complete');
  });
});
