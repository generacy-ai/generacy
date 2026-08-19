import type { Issue } from '@generacy-ai/cockpit';
import type { ClassifiedIssue } from '../shared/classify-issue.js';

export type SnapshotKey = string;

export type ChecksRollup = 'pending' | 'success' | 'failure' | 'none' | 'error';
export type PrLifecycle = 'open' | 'closed' | 'merged';

export interface IssueSnapshot {
  kind: 'issue';
  repo: string;
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED';
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;
  labels: string[];
  classified: ClassifiedIssue;
}

export interface PrSnapshot {
  kind: 'pr';
  repo: string;
  number: number;
  url: string;
  lifecycle: PrLifecycle;
  state: 'OPEN' | 'CLOSED';
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;
  labels: string[];
  classified: ClassifiedIssue;
  checksRollup: ChecksRollup;
  headRefOid?: string;
  cyclesSinceLastCheckFetch: number;
}

export type Snapshot = IssueSnapshot | PrSnapshot;
export type SnapshotMap = Map<SnapshotKey, Snapshot>;

// #1106 Q2=B — normalize `repo` to lowercase so map lookups match regardless
// of caller casing. `poll-loop.ts` builds keys from `IssueRef.repo` (operator-
// typed via epic body — arbitrary casing), while `smee-source.ts` looks up
// keys via `ev.repo` (webhook payload — GitHub-canonical casing). Prior to
// this normalization, `smee-source.ts:375`'s `PrSnapshot` cache lookup missed
// on every case mismatch, causing `pr-checks` and `completed:validate` events
// to be emitted with `checks: undefined` instead of `green`/`red`. Snapshot
// values retain original casing on their own `.repo` field.
export function snapshotKey(repo: string, kind: 'issue' | 'pr', number: number): SnapshotKey {
  return `${repo.toLowerCase()}#${kind}#${number}`;
}

export function buildIssueSnapshot(
  repo: string,
  issue: Pick<Issue, 'number' | 'url' | 'state' | 'stateReason' | 'labels'>,
  classified: ClassifiedIssue,
): IssueSnapshot {
  return {
    kind: 'issue',
    repo,
    number: issue.number,
    url: issue.url,
    state: issue.state,
    stateReason: issue.stateReason,
    labels: [...issue.labels],
    classified,
  };
}

export function buildPrSnapshot(
  repo: string,
  issue: Pick<Issue, 'number' | 'url' | 'state' | 'stateReason' | 'labels'>,
  classified: ClassifiedIssue,
  lifecycle: PrLifecycle,
  rollup: ChecksRollup,
  extras: { headRefOid?: string; cyclesSinceLastCheckFetch?: number } = {},
): PrSnapshot {
  return {
    kind: 'pr',
    repo,
    number: issue.number,
    url: issue.url,
    state: issue.state,
    stateReason: issue.stateReason,
    lifecycle,
    labels: [...issue.labels],
    classified,
    checksRollup: rollup,
    ...(extras.headRefOid != null ? { headRefOid: extras.headRefOid } : {}),
    cyclesSinceLastCheckFetch: extras.cyclesSinceLastCheckFetch ?? 0,
  };
}
