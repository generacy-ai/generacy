import type { Issue, CockpitState, StuckReason } from '@generacy-ai/cockpit';
import type { ClassifiedIssue } from '../shared/classify-issue.js';

export interface StatusRow {
  repo: string;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  state: CockpitState;
  sourceLabel: string;
  prNumber: number | null;
  checks: 'pending' | 'success' | 'failure' | 'none';
  url: string;
  stuck: boolean;
  stuckReason: StuckReason;
}

export function buildStatusRow(
  repo: string,
  issue: Pick<Issue, 'number' | 'title' | 'url'>,
  classified: ClassifiedIssue,
  kind: 'issue' | 'pr',
  prNumber: number | null,
  checks: 'pending' | 'success' | 'failure' | 'none',
  liveness?: { stuck: boolean; stuckReason: StuckReason },
): StatusRow {
  return {
    repo,
    kind,
    number: issue.number,
    title: issue.title,
    state: classified.state,
    sourceLabel: classified.sourceLabel,
    prNumber,
    checks,
    url: issue.url,
    stuck: liveness?.stuck ?? false,
    stuckReason: liveness?.stuckReason ?? null,
  };
}
