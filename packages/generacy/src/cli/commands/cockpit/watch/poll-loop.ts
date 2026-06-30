import type { CheckRunSummary, GhWrapper, Issue, StuckReason } from '@generacy-ai/cockpit';
import { readJournalLiveness } from '@generacy-ai/cockpit';
import { classifyIssue } from '../shared/classify-issue.js';
import { listAllIssues } from '../shared/pagination.js';
import type { Scope } from '../shared/scoping.js';
import { rollup } from './check-rollup.js';
import { computeTransitions, type CockpitEvent } from './diff.js';
import { derivePrLifecycle } from './pr-state.js';
import {
  buildIssueSnapshot,
  buildPrSnapshot,
  snapshotKey,
  type Snapshot,
  type SnapshotMap,
} from './snapshot.js';

export interface PollDeps {
  gh: GhWrapper;
  scope: Scope;
  safetyCap?: number;
  pageSize?: number;
  stuckThresholdMinutes?: number;
  readLiveness?: (issueNumber: number, thresholdMinutes: number) => Promise<{ stuck: boolean; stuckReason: StuckReason }>;
  logger?: { warn: (msg: string) => void };
  now?: () => string;
}

export interface PollResult {
  curr: SnapshotMap;
  events: CockpitEvent[];
}

function isPullRequest(issue: Issue): boolean {
  if (issue.url != null && /\/pull\/\d+/.test(issue.url)) return true;
  return issue.labels.includes('type:pr');
}

function queryFor(scope: Scope, repo: string, issueNumbers?: number[]): string {
  if (scope.kind === 'epic') {
    const numbers =
      issueNumbers ??
      scope.issues.filter((r) => r.repo === repo).map((r) => r.number);
    const refs = numbers.map((n) => String(n)).join(' ');
    if (refs.length === 0) {
      // No epic children in this repo; return a query that produces zero results.
      return `repo:${repo} is:issue no:label cockpit-no-match-sentinel`;
    }
    return `repo:${repo} ${refs}`;
  }
  return `repo:${repo} is:open`;
}

function reposForScope(scope: Scope): string[] {
  if (scope.kind === 'epic') {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const ref of scope.issues) {
      if (!seen.has(ref.repo)) {
        seen.add(ref.repo);
        out.push(ref.repo);
      }
    }
    // If the epic has no children resolved, fall back to the epic's own repo
    // so we still issue a (zero-result) poll rather than producing nothing.
    if (out.length === 0) return [scope.ownerRepo];
    return out;
  }
  return scope.repos;
}

/**
 * Run one poll cycle: list issues per repo, classify, snapshot, fetch PR checks,
 * derive PR lifecycle, compute transitions vs `prev`.
 *
 * Pure function over its deps — all I/O goes through `deps.gh`. The shell
 * (`watch.ts`) owns the loop, sleep, and signal handling.
 */
export async function runOnePoll(
  prev: SnapshotMap,
  deps: PollDeps,
): Promise<PollResult> {
  const curr: SnapshotMap = new Map();
  const repos = reposForScope(deps.scope);

  for (const repo of repos) {
    const query = queryFor(deps.scope, repo);
    const issues = await listAllIssues(deps.gh, query, {
      ...(deps.safetyCap != null ? { safetyCap: deps.safetyCap } : {}),
      ...(deps.pageSize != null ? { pageSize: deps.pageSize } : {}),
      ...(deps.logger != null ? { logger: deps.logger } : {}),
    });

    for (const issue of issues) {
      const classified = classifyIssue(issue.labels);
      let snapshot: Snapshot;
      if (isPullRequest(issue)) {
        const key = snapshotKey(repo, 'pr', issue.number);
        const prevSnap = prev.get(key);
        const lifecycle = await derivePrLifecycle(repo, prevSnap, issue, {
          getPullRequest: deps.gh.getPullRequest.bind(deps.gh),
        });
        let checks: CheckRunSummary[];
        try {
          checks = await deps.gh.getPullRequestCheckRuns(repo, issue.number);
        } catch {
          checks = [];
        }
        snapshot = buildPrSnapshot(repo, issue, classified, lifecycle, rollup(checks));
        curr.set(key, snapshot);
      } else {
        const key = snapshotKey(repo, 'issue', issue.number);
        let liveness: { stuck: boolean; stuckReason: StuckReason } | undefined;
        if (
          classified.state === 'active' &&
          classified.sourceLabel === 'agent:in-progress' &&
          deps.stuckThresholdMinutes != null
        ) {
          const threshold = deps.stuckThresholdMinutes;
          if (deps.readLiveness != null) {
            liveness = await deps.readLiveness(issue.number, threshold);
          } else {
            const result = await readJournalLiveness({
              issueNumber: issue.number,
              thresholdMinutes: threshold,
              ...(deps.logger != null ? { logger: deps.logger } : {}),
            });
            liveness = { stuck: result.stuck, stuckReason: result.stuckReason };
          }
        }
        snapshot = buildIssueSnapshot(repo, issue, classified, liveness);
        curr.set(key, snapshot);
      }
    }
  }

  const now = deps.now;
  const events = now != null ? computeTransitions(prev, curr, now) : computeTransitions(prev, curr);
  return { curr, events };
}
