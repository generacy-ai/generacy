import type { CockpitState } from '@generacy-ai/cockpit';
import { isActionableSnapshot } from './actionable.js';
import type {
  IssueSnapshot,
  PrSnapshot,
  Snapshot,
  SnapshotMap,
} from './snapshot.js';

export type CockpitEventKind = 'issue' | 'pr';
export type CockpitEventDiscriminator =
  | 'label-change'
  | 'issue-closed'
  | 'pr-merged'
  | 'pr-closed'
  | 'pr-checks';

export interface CockpitEvent {
  type: 'issue-transition';
  ts: string;
  repo: string;
  kind: CockpitEventKind;
  number: number;
  from: CockpitState | null;
  to: CockpitState | null;
  sourceLabel: string | null;
  url: string;
  event: CockpitEventDiscriminator;
  labels: string[];
  initial?: true;
  checks?: 'green' | 'red' | 'pending';
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEvent(
  curr: Snapshot,
  event: CockpitEventDiscriminator,
  from: CockpitState | null,
  to: CockpitState | null,
  sourceLabel: string | null,
  ts: string,
  opts: { initial?: true } = {},
): CockpitEvent {
  const out: CockpitEvent = {
    type: 'issue-transition',
    ts,
    repo: curr.repo,
    kind: curr.kind,
    number: curr.number,
    from,
    to,
    sourceLabel,
    url: curr.url,
    event,
    labels: [...curr.labels],
  };
  if (opts.initial === true) out.initial = true;
  return out;
}

function diffIssue(
  prev: IssueSnapshot,
  curr: IssueSnapshot,
  ts: string,
  out: CockpitEvent[],
): void {
  if (
    prev.classified.state !== curr.classified.state ||
    prev.classified.sourceLabel !== curr.classified.sourceLabel
  ) {
    out.push(
      makeEvent(
        curr,
        'label-change',
        prev.classified.state,
        curr.classified.state,
        curr.classified.sourceLabel,
        ts,
      ),
    );
  }
  if (prev.state === 'OPEN' && curr.state === 'CLOSED') {
    out.push(makeEvent(curr, 'issue-closed', curr.classified.state, 'terminal', null, ts));
  }
}

function diffPr(
  prev: PrSnapshot,
  curr: PrSnapshot,
  ts: string,
  out: CockpitEvent[],
): void {
  if (
    prev.classified.state !== curr.classified.state ||
    prev.classified.sourceLabel !== curr.classified.sourceLabel
  ) {
    out.push(
      makeEvent(
        curr,
        'label-change',
        prev.classified.state,
        curr.classified.state,
        curr.classified.sourceLabel,
        ts,
      ),
    );
  }
  if (prev.lifecycle !== 'merged' && curr.lifecycle === 'merged') {
    out.push(makeEvent(curr, 'pr-merged', curr.classified.state, 'terminal', null, ts));
  } else if (prev.lifecycle !== 'closed' && curr.lifecycle === 'closed') {
    out.push(makeEvent(curr, 'pr-closed', curr.classified.state, 'terminal', null, ts));
  }
  if (prev.checksRollup !== curr.checksRollup) {
    out.push(
      makeEvent(
        curr,
        'pr-checks',
        curr.classified.state,
        curr.classified.state,
        null,
        ts,
      ),
    );
  }
}

function computeInitialSweep(curr: SnapshotMap, ts: string): CockpitEvent[] {
  const out: CockpitEvent[] = [];
  const sortedKeys = [...curr.keys()].sort();
  for (const key of sortedKeys) {
    const snap = curr.get(key)!;
    if (!isActionableSnapshot(snap)) continue;
    out.push(
      makeEvent(
        snap,
        'label-change',
        null,
        snap.classified.state,
        snap.classified.sourceLabel,
        ts,
        { initial: true },
      ),
    );
  }
  return out;
}

/**
 * Compute the set of transitions between two SnapshotMaps. Events for the same
 * key are emitted in the order: label-change → lifecycle → pr-checks.
 *
 * First-poll (prev empty): emits one line per actionable snapshot in `curr`,
 * each marked `initial: true`. Non-actionable snapshots stay silent.
 *
 * Mid-stream first-sight (#935): on polls 2..N, a key present in `curr` but
 * absent from `prev` (e.g. `cockpit scope add` appended a new ref to the epic
 * body) emits one `label-change` event with `initial: true` if actionable —
 * matching `computeInitialSweep`'s per-key shape. Non-actionable snapshots
 * stay silent. Removals stay silent (mirrors FR-002 "removal emits nothing").
 */
export function computeTransitions(
  prev: SnapshotMap,
  curr: SnapshotMap,
  now: () => string = nowIso,
): CockpitEvent[] {
  const ts = now();
  if (prev.size === 0) return computeInitialSweep(curr, ts);
  const out: CockpitEvent[] = [];
  for (const [key, currSnap] of curr) {
    const prevSnap = prev.get(key);
    if (prevSnap == null) {
      if (isActionableSnapshot(currSnap)) {
        out.push(
          makeEvent(
            currSnap,
            'label-change',
            null,
            currSnap.classified.state,
            currSnap.classified.sourceLabel,
            ts,
            { initial: true },
          ),
        );
      }
      continue;
    }
    if (prevSnap.kind === 'issue' && currSnap.kind === 'issue') {
      diffIssue(prevSnap, currSnap, ts, out);
    } else if (prevSnap.kind === 'pr' && currSnap.kind === 'pr') {
      diffPr(prevSnap, currSnap, ts, out);
    }
  }
  return out;
}
