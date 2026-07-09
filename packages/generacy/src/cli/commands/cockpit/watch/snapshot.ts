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
}

export type Snapshot = IssueSnapshot | PrSnapshot;
export type SnapshotMap = Map<SnapshotKey, Snapshot>;

export function snapshotKey(repo: string, kind: 'issue' | 'pr', number: number): SnapshotKey {
  return `${repo}#${kind}#${number}`;
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
  };
}
