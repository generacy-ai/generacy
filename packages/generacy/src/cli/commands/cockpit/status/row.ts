import type { Issue, CockpitState } from '@generacy-ai/cockpit';
import type { ClassifiedIssue } from '../shared/classify-issue.js';

export interface StatusRow {
  repo: string;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  state: CockpitState;
  sourceLabel: string;
  issueState: 'OPEN' | 'CLOSED';
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;
  prNumber: number | null;
  checks: 'pending' | 'success' | 'failure' | 'none' | 'error';
  url: string;
  phase: string | null;
}

export function buildStatusRow(
  repo: string,
  issue: Pick<Issue, 'number' | 'title' | 'url' | 'state' | 'stateReason'>,
  classified: ClassifiedIssue,
  kind: 'issue' | 'pr',
  prNumber: number | null,
  checks: 'pending' | 'success' | 'failure' | 'none' | 'error',
  phase: string | null,
): StatusRow {
  return {
    repo,
    kind,
    number: issue.number,
    title: issue.title,
    state: classified.state,
    sourceLabel: classified.sourceLabel,
    issueState: issue.state,
    stateReason: issue.stateReason,
    prNumber,
    checks,
    url: issue.url,
    phase,
  };
}
