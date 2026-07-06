import type {
  CheckRunSummary,
  GhWrapper,
  Issue,
  IssueRef,
} from '@generacy-ai/cockpit';
import { classifyIssue } from '../shared/classify-issue.js';
import { listAllIssues } from '../shared/pagination.js';
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
  /** Refs resolved from the epic body for this tick. */
  refs: IssueRef[];
  /** `owner/repo` of the epic itself — used only as the zero-refs fallback query target. */
  epicOwnerRepo: string;
  safetyCap?: number;
  pageSize?: number;
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

function queryForRepo(refs: IssueRef[], repo: string): string {
  const numbers = refs.filter((r) => r.repo === repo).map((r) => r.number);
  const nums = numbers.map((n) => String(n)).join(' ');
  if (nums.length === 0) {
    // Zero-result sentinel to keep the poll shape consistent.
    return `repo:${repo} is:issue no:label cockpit-no-match-sentinel`;
  }
  return `repo:${repo} ${nums}`;
}

function reposFromRefs(refs: IssueRef[], fallback: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (!seen.has(ref.repo)) {
      seen.add(ref.repo);
      out.push(ref.repo);
    }
  }
  if (out.length === 0) return [fallback];
  return out;
}

/**
 * Run one poll cycle: list issues per repo, classify, snapshot, fetch PR checks,
 * derive PR lifecycle, compute transitions vs `prev`.
 *
 * Pure over its deps — all I/O goes through `deps.gh`. The shell (`watch.ts`)
 * owns the loop, sleep, resolver call, and signal handling.
 */
export async function runOnePoll(
  prev: SnapshotMap,
  deps: PollDeps,
): Promise<PollResult> {
  const curr: SnapshotMap = new Map();
  const repos = reposFromRefs(deps.refs, deps.epicOwnerRepo);

  for (const repo of repos) {
    const query = queryForRepo(deps.refs, repo);
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
        snapshot = buildIssueSnapshot(repo, issue, classified);
        curr.set(key, snapshot);
      }
    }
  }

  const now = deps.now;
  const events = now != null ? computeTransitions(prev, curr, now) : computeTransitions(prev, curr);
  return { curr, events };
}
