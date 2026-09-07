import type {
  GhWrapper,
  Issue,
  IssueRef,
} from '@generacy-ai/cockpit';
import { classifyIssue } from '../shared/classify-issue.js';
import { filterToRefSet } from '../shared/ref-set-filter.js';
import { rollup } from './check-rollup.js';
import { computeTransitions, type CockpitEvent } from './diff.js';
import { derivePrChecksNeeded, derivePrLifecycle } from './pr-state.js';
import {
  buildIssueSnapshot,
  buildPrSnapshot,
  snapshotKey,
  type ChecksRollup,
  type PrSnapshot,
  type Snapshot,
  type SnapshotMap,
} from './snapshot.js';

export interface PollDeps {
  gh: GhWrapper;
  /** Refs resolved from the epic body for this tick — authoritative scope. */
  refs: IssueRef[];
  logger?: { warn: (msg: string) => void; debug?: (msg: string) => void };
  now?: () => string;
  cycleNumber?: number;
}

export interface PollResult {
  curr: SnapshotMap;
  events: CockpitEvent[];
}

function isPullRequest(issue: Issue): boolean {
  if (issue.url != null && /\/pull\/\d+/.test(issue.url)) return true;
  return issue.labels.includes('type:pr');
}

function reposFromRefs(refs: IssueRef[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (!seen.has(ref.repo)) {
      seen.add(ref.repo);
      out.push(ref.repo);
    }
  }
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
  const repos = reposFromRefs(deps.refs);

  for (const repo of repos) {
    const numbers = deps.refs
      .filter((r) => r.repo === repo)
      .map((r) => r.number);
    if (numbers.length === 0) continue;
    const fetched = await deps.gh.batchLookupIssuesOrPrs(repo, numbers);
    const issues = filterToRefSet(fetched, repo, deps.refs, deps.logger);

    for (const issue of issues) {
      const classified = classifyIssue(issue.labels);
      let snapshot: Snapshot;
      if (isPullRequest(issue)) {
        const key = snapshotKey(repo, 'pr', issue.number);
        const prevSnap = prev.get(key);
        const prevPr: PrSnapshot | undefined =
          prevSnap != null && prevSnap.kind === 'pr' ? prevSnap : undefined;
        const lifecycle = await derivePrLifecycle(repo, prevSnap, issue, {
          getPullRequest: deps.gh.getPullRequest.bind(deps.gh),
        });

        let currentHeadRefOid: string | undefined = prevPr?.headRefOid;
        if (prevPr == null && lifecycle === 'open') {
          try {
            const pr = await deps.gh.getPullRequest(repo, issue.number);
            if (pr.headRefOid != null) currentHeadRefOid = pr.headRefOid;
          } catch {
            // Best-effort — leave undefined, gate will not spuriously fetch.
          }
        }

        const prevCycles = prevPr?.cyclesSinceLastCheckFetch ?? 0;
        const decision = derivePrChecksNeeded({
          prevSnapshot: prevPr,
          currentLifecycle: lifecycle,
          currentLabels: issue.labels,
          currentHeadRefOid,
          cyclesSinceLastCheckFetch: prevCycles,
        });
        deps.logger?.debug?.(
          `pr-checks-gate ${repo}#${issue.number}: fetch=${decision.fetch} reason=${decision.reason}`,
        );

        let checksResult: ChecksRollup;
        let nextCycles: number;
        if (decision.fetch) {
          try {
            checksResult = rollup(
              await deps.gh.getPullRequestCheckRuns(repo, issue.number),
            );
          } catch {
            checksResult = 'error';
          }
          nextCycles = 0;
        } else {
          checksResult = prevPr?.checksRollup ?? 'none';
          nextCycles = prevCycles + 1;
        }

        snapshot = buildPrSnapshot(repo, issue, classified, lifecycle, checksResult, {
          ...(currentHeadRefOid != null ? { headRefOid: currentHeadRefOid } : {}),
          cyclesSinceLastCheckFetch: nextCycles,
        });
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
