/**
 * `webhookToStreamEvent` — pure Q1=A mapping. Takes a normalized
 * `{ githubEvent, action, body }` triple, the epic's ref-set filter, and
 * returns one `CockpitStreamEvent` per matched ref (or null when the payload
 * is out of scope).
 *
 * Contract: `specs/978-summary-generacy-cockpit/contracts/webhook-to-event-mapping.md`.
 *
 * Reuses `CockpitEventSchema` from `../watch/emit.ts` — does NOT extend the
 * enum. `from`/`to` are best-effort null (see contract § "Emitted shape").
 */
import type { CockpitEventValidated } from '../watch/emit.js';
import { classifyIssue } from '../shared/classify-issue.js';

export interface RefSetView {
  epicRef: string;
  epicNumber: number;
  epicRepo: string;
  issues: Set<string>;
  prs: Set<string>;
  watchedRepos: Set<string>;
}

function refKey(owner: string, repo: string, num: number): string {
  return `${owner}/${repo}#${num}`;
}

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function extractRepo(body: Record<string, unknown>): {
  owner: string;
  repo: string;
} | null {
  const repoObj = body['repository'];
  if (repoObj == null || typeof repoObj !== 'object') return null;
  const r = repoObj as Record<string, unknown>;
  const name = r['name'];
  const ownerObj = r['owner'];
  if (typeof name !== 'string' || ownerObj == null || typeof ownerObj !== 'object') {
    return null;
  }
  const login = (ownerObj as Record<string, unknown>)['login'];
  if (typeof login !== 'string') return null;
  return { owner: login, repo: name };
}

function extractIssue(body: Record<string, unknown>): {
  number: number;
  labels: string[];
} | null {
  const issueObj = body['issue'];
  if (issueObj == null || typeof issueObj !== 'object') return null;
  const i = issueObj as Record<string, unknown>;
  const num = i['number'];
  if (typeof num !== 'number') return null;
  const rawLabels = i['labels'];
  const labels: string[] = [];
  if (Array.isArray(rawLabels)) {
    for (const l of rawLabels) {
      if (l != null && typeof l === 'object') {
        const lname = (l as Record<string, unknown>)['name'];
        if (typeof lname === 'string') labels.push(lname);
      }
    }
  }
  return { number: num, labels };
}

function extractPrNumber(body: Record<string, unknown>): number | null {
  const prObj = body['pull_request'];
  if (prObj == null || typeof prObj !== 'object') return null;
  const num = (prObj as Record<string, unknown>)['number'];
  return typeof num === 'number' ? num : null;
}

function extractPrMerged(body: Record<string, unknown>): boolean | null {
  const prObj = body['pull_request'];
  if (prObj == null || typeof prObj !== 'object') return null;
  const merged = (prObj as Record<string, unknown>)['merged'];
  return typeof merged === 'boolean' ? merged : null;
}

function extractLabelName(body: Record<string, unknown>): string | null {
  const labelObj = body['label'];
  if (labelObj == null || typeof labelObj !== 'object') return null;
  const name = (labelObj as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : null;
}

function extractCheckPrs(
  body: Record<string, unknown>,
  container: 'check_run' | 'check_suite',
): number[] {
  const holder = body[container];
  if (holder == null || typeof holder !== 'object') return [];
  const prs = (holder as Record<string, unknown>)['pull_requests'];
  if (!Array.isArray(prs)) return [];
  const out: number[] = [];
  for (const p of prs) {
    if (p != null && typeof p === 'object') {
      const num = (p as Record<string, unknown>)['number'];
      if (typeof num === 'number') out.push(num);
    }
  }
  return out;
}

function buildEvent(
  event: 'label-change' | 'issue-closed' | 'pr-merged' | 'pr-closed' | 'pr-checks',
  owner: string,
  repo: string,
  kind: 'issue' | 'pr',
  number: number,
  sourceLabelArg: string | null,
  labels: string[],
  now: () => string,
): CockpitEventValidated {
  const classified = classifyIssue(labels);
  const classifiedSource = classified.sourceLabel !== '' ? classified.sourceLabel : null;
  return {
    type: 'issue-transition',
    ts: now(),
    repo: `${owner}/${repo}`,
    kind,
    number,
    from: null,
    to: classified.state,
    sourceLabel: classifiedSource ?? sourceLabelArg,
    url: `https://github.com/${owner}/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    event,
    labels,
  };
}

/**
 * Q1=A mapping. Returns exactly one `CockpitEventValidated` for `issues.*` and
 * `pull_request.*` matches, or one per matched PR for `check_run.completed` /
 * `check_suite.completed`. Callers that want single-event semantics should
 * take the first element.
 */
export function webhookToStreamEvent(
  githubEvent: string,
  action: string,
  body: Record<string, unknown>,
  refSet: RefSetView,
  now: () => string,
): CockpitEventValidated | CockpitEventValidated[] | null {
  const repoInfo = extractRepo(body);
  if (repoInfo == null) return null;
  const { owner, repo } = repoInfo;

  if (!refSet.watchedRepos.has(repoKey(owner, repo))) return null;

  if (githubEvent === 'issues') {
    const issue = extractIssue(body);
    if (issue == null) return null;
    if (!refSet.issues.has(refKey(owner, repo, issue.number))) return null;

    if (action === 'labeled' || action === 'unlabeled') {
      const labelName = extractLabelName(body);
      if (labelName == null) return null;
      return buildEvent(
        'label-change',
        owner,
        repo,
        'issue',
        issue.number,
        labelName,
        issue.labels,
        now,
      );
    }
    if (action === 'closed') {
      return buildEvent(
        'issue-closed',
        owner,
        repo,
        'issue',
        issue.number,
        null,
        issue.labels,
        now,
      );
    }
    return null;
  }

  if (githubEvent === 'pull_request') {
    const prNum = extractPrNumber(body);
    if (prNum == null) return null;
    if (!refSet.prs.has(refKey(owner, repo, prNum))) return null;

    if (action === 'closed') {
      const merged = extractPrMerged(body);
      const evName = merged === true ? 'pr-merged' : 'pr-closed';
      return buildEvent(evName, owner, repo, 'pr', prNum, null, [], now);
    }
    return null;
  }

  if (
    (githubEvent === 'check_run' || githubEvent === 'check_suite') &&
    action === 'completed'
  ) {
    const container = githubEvent as 'check_run' | 'check_suite';
    const prs = extractCheckPrs(body, container);
    const out: CockpitEventValidated[] = [];
    const seen = new Set<number>();
    for (const prNum of prs) {
      if (seen.has(prNum)) continue;
      seen.add(prNum);
      if (!refSet.prs.has(refKey(owner, repo, prNum))) continue;
      out.push(buildEvent('pr-checks', owner, repo, 'pr', prNum, null, [], now));
    }
    if (out.length === 0) return null;
    return out;
  }

  return null;
}
