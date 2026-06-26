import type { CockpitState } from '@generacy-ai/cockpit';
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
): CockpitEvent {
  return {
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

/**
 * Compute the set of transitions between two SnapshotMaps. Events for the same
 * key are emitted in the order: label-change → lifecycle → pr-checks.
 *
 * First-poll baseline (R9): if `prev` is empty, returns []. If a specific key
 * is absent from `prev`, that key is treated as baseline and emits nothing.
 */
export function computeTransitions(
  prev: SnapshotMap,
  curr: SnapshotMap,
  now: () => string = nowIso,
): CockpitEvent[] {
  if (prev.size === 0) return [];
  const out: CockpitEvent[] = [];
  const ts = now();
  for (const [key, currSnap] of curr) {
    const prevSnap = prev.get(key);
    if (prevSnap == null) continue;
    if (prevSnap.kind === 'issue' && currSnap.kind === 'issue') {
      diffIssue(prevSnap, currSnap, ts, out);
    } else if (prevSnap.kind === 'pr' && currSnap.kind === 'pr') {
      diffPr(prevSnap, currSnap, ts, out);
    }
  }
  return out;
}
