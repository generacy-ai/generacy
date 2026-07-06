import { z } from 'zod';
import {
  nodeChildProcessRunner,
  type CommandRunner,
} from './command-runner.js';

export interface Issue {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  url: string;
  body: string;
  author?: { login: string };
  createdAt: string;
}

export interface CheckRunSummary {
  name: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
  conclusion?: string;
  url?: string;
}

export interface ListIssuesOptions {
  limit?: number;
  repo?: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  headRefName: string;
}

export interface PullRequestDetail {
  number: number;
  title: string;
  url: string;
  base: string;
  head: string;
  body: string;
  author: { login: string } | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  labels: string[];
  diff: string;
  diffTruncated: boolean;
}

export interface MergeResult {
  merged: boolean;
  commitSha?: string;
}

export interface RequiredChecksResult {
  source: 'branch-protection' | 'fallback-pr-checks';
  names: string[] | null;
}

export interface PullRequestSummary {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt?: string;
  closedAt?: string;
  url: string;
  isDraft: boolean;
  labels: string[];
}

export interface IssueLabelsResult {
  labels: string[];
}

export interface IssueStateResult {
  state: 'OPEN' | 'CLOSED';
  closedAt: string | null;
  labels: string[];
  assignees: string[];
  title: string;
}

export interface IssueComment {
  body: string;
  author: string;
  createdAt: string;
  url: string;
}

export interface OpenPrForBranch {
  url: string;
  number: number;
}

export const DIFF_BYTE_CAP = 256 * 1024;
export const DIFF_TRUNCATION_MARKER = '\n... [diff truncated at 256 KiB] ...\n';

export interface GhWrapper {
  listIssues(query: string, options?: ListIssuesOptions): Promise<Issue[]>;
  getIssue(repo: string, number: number): Promise<Issue>;
  addLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  removeLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  addLabel(repo: string, issue: number, label: string): Promise<void>;
  removeLabel(repo: string, issue: number, label: string): Promise<void>;
  getPullRequestCheckRuns(repo: string, prNumber: number): Promise<CheckRunSummary[]>;
  resolveIssueToPR(repo: string, issueNumber: number): Promise<number | null>;
  getPullRequest(repo: string, prNumber: number): Promise<PullRequestSummary>;
  resolveIssueToPRRef(repo: string, issue: number): Promise<PullRequestRef | null>;
  getPullRequestDetail(repo: string, prNumber: number): Promise<PullRequestDetail>;
  mergePullRequest(
    repo: string,
    prNumber: number,
    opts: { squash: true },
  ): Promise<MergeResult>;
  getRequiredCheckNames(
    repo: string,
    branch: string,
  ): Promise<RequiredChecksResult>;
  fetchIssueLabels(repo: string, issue: number): Promise<IssueLabelsResult>;
  fetchIssueState(repo: string, issue: number): Promise<IssueStateResult>;
  postIssueComment(repo: string, issue: number, body: string): Promise<{ url: string }>;
  addAssignees(repo: string, issue: number, logins: string[]): Promise<void>;
  fetchIssueTimeline(repo: string, issue: number): Promise<unknown[]>;
  fetchIssueComments(repo: string, issue: number): Promise<IssueComment[]>;
  getCurrentUser(): Promise<string>;
  findOpenPrForBranch(repo: string, branch: string): Promise<OpenPrForBranch | null>;
  prDiffNames(repo: string, prNumber: number): Promise<string[]>;
  prDiffPatch(repo: string, prNumber: number): Promise<string>;
}

const IssueRawSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  labels: z
    .array(
      z.union([
        z.string(),
        z.object({ name: z.string() }).passthrough(),
      ]),
    )
    .default([]),
  url: z.string(),
  body: z.string().nullable().optional(),
  author: z
    .object({ login: z.string() })
    .passthrough()
    .nullable()
    .optional(),
  createdAt: z.string().optional(),
});

const CheckRunRawSchema = z
  .object({
    name: z.string(),
    state: z.string().optional(),
    bucket: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().nullable().optional(),
    detailsUrl: z.string().optional(),
    link: z.string().optional(),
  })
  .passthrough();

const PullRequestRefRawSchema = z
  .object({
    number: z.number().int(),
    url: z.string(),
    state: z.string(),
    isDraft: z.boolean().optional(),
    headRefName: z.string(),
  })
  .passthrough();

const PullRequestDetailRawSchema = z
  .object({
    number: z.number().int(),
    title: z.string(),
    url: z.string(),
    baseRefName: z.string(),
    headRefName: z.string(),
    body: z.string().nullable().optional(),
    author: z
      .object({ login: z.string() })
      .passthrough()
      .nullable()
      .optional(),
    state: z.string(),
    isDraft: z.boolean().optional(),
    labels: z
      .array(
        z.union([
          z.string(),
          z.object({ name: z.string() }).passthrough(),
        ]),
      )
      .default([]),
  })
  .passthrough();

const MergeCommitRawSchema = z
  .object({
    mergeCommit: z
      .object({ oid: z.string() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const BranchProtectionRawSchema = z
  .object({
    required_status_checks: z
      .object({
        contexts: z.array(z.string()).default([]),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const LabelLikeSchema = z.union([
  z.string(),
  z.object({ name: z.string() }).passthrough(),
]);

const IssueLabelsRawSchema = z.object({
  labels: z.array(LabelLikeSchema).default([]),
});

const IssueStateRawSchema = z.object({
  state: z.string(),
  closedAt: z.string().nullable().optional(),
  labels: z.array(LabelLikeSchema).default([]),
  assignees: z.array(z.object({ login: z.string() }).passthrough()).default([]),
  title: z.string().default(''),
});

const IssueCommentRawSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  body: z.string().default(''),
  author: z
    .object({ login: z.string() })
    .passthrough()
    .nullable()
    .optional(),
  createdAt: z.string(),
  url: z.string().optional(),
});

const IssueCommentsRawSchema = z.object({
  comments: z.array(IssueCommentRawSchema).default([]),
});

const TimelineEventRawSchema = z
  .object({
    event: z.string().optional(),
    created_at: z.string().optional(),
    label: z.object({ name: z.string() }).optional(),
  })
  .passthrough();

const UserRawSchema = z.object({ login: z.string() });

const OpenPrForBranchRawSchema = z.array(
  z.object({ url: z.string(), number: z.number() }),
);

function normalizeIssueState(state: string): 'OPEN' | 'CLOSED' {
  return state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
}

function normalizePullRequestState(state: string): 'OPEN' | 'CLOSED' | 'MERGED' {
  const upper = state.toUpperCase();
  if (upper === 'MERGED') return 'MERGED';
  if (upper === 'CLOSED') return 'CLOSED';
  return 'OPEN';
}

function extractLabelNames(
  raw: Array<string | { name: string }>,
): string[] {
  return raw.map((l) => (typeof l === 'string' ? l : l.name));
}

function applyDiffCap(raw: string): { diff: string; diffTruncated: boolean } {
  const buf = Buffer.from(raw, 'utf-8');
  if (buf.byteLength <= DIFF_BYTE_CAP) {
    return { diff: raw, diffTruncated: false };
  }
  const head = buf.subarray(0, DIFF_BYTE_CAP).toString('utf-8');
  return {
    diff: head + DIFF_TRUNCATION_MARKER,
    diffTruncated: true,
  };
}

function normalizeCheckState(raw: z.infer<typeof CheckRunRawSchema>): CheckRunSummary['state'] {
  const candidate = (raw.state ?? raw.bucket ?? raw.status ?? '').toUpperCase();
  switch (candidate) {
    case 'SUCCESS':
    case 'PASS':
      return 'SUCCESS';
    case 'FAIL':
    case 'FAILURE':
      return 'FAILURE';
    case 'PENDING':
    case 'IN_PROGRESS':
    case 'QUEUED':
      return 'PENDING';
    case 'NEUTRAL':
      return 'NEUTRAL';
    case 'SKIPPED':
    case 'SKIPPING':
      return 'SKIPPED';
    case 'CANCELLED':
    case 'CANCELED':
      return 'CANCELLED';
    default:
      return 'PENDING';
  }
}

function parseIssues(stdout: string): Issue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `gh returned malformed JSON for listIssues: ${stdout.slice(0, 200)}`,
    );
  }
  const arr = z.array(IssueRawSchema).safeParse(parsed);
  if (!arr.success) {
    throw new Error(`gh listIssues JSON shape mismatch: ${arr.error.message}`);
  }
  return arr.data.map<Issue>((raw) => ({
    number: raw.number,
    title: raw.title,
    state: normalizeIssueState(raw.state),
    labels: raw.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    url: raw.url,
    body: raw.body ?? '',
    author: raw.author?.login != null ? { login: raw.author.login } : undefined,
    createdAt: raw.createdAt ?? '',
  }));
}

const PullRequestRawSchema = z
  .object({
    number: z.number().int().optional(),
    state: z.string(),
    mergedAt: z.string().nullable().optional(),
    closedAt: z.string().nullable().optional(),
    url: z.string(),
    isDraft: z.boolean().optional(),
    labels: z
      .array(
        z.union([z.string(), z.object({ name: z.string() }).passthrough()]),
      )
      .default([]),
  })
  .passthrough();

function normalizePrState(raw: string, mergedAt?: string | null): 'OPEN' | 'CLOSED' | 'MERGED' {
  const upper = raw.toUpperCase();
  if (upper === 'MERGED') return 'MERGED';
  if (upper === 'CLOSED') {
    return mergedAt != null && mergedAt.length > 0 ? 'MERGED' : 'CLOSED';
  }
  return 'OPEN';
}

function parsePullRequest(stdout: string, prNumber: number): PullRequestSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `gh returned malformed JSON for getPullRequest: ${stdout.slice(0, 200)}`,
    );
  }
  const result = PullRequestRawSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`gh pr view JSON shape mismatch: ${result.error.message}`);
  }
  const raw = result.data;
  const mergedAt = raw.mergedAt ?? undefined;
  const closedAt = raw.closedAt ?? undefined;
  return {
    number: raw.number ?? prNumber,
    state: normalizePrState(raw.state, mergedAt),
    ...(mergedAt != null ? { mergedAt } : {}),
    ...(closedAt != null ? { closedAt } : {}),
    url: raw.url,
    isDraft: raw.isDraft ?? false,
    labels: raw.labels.map((l) => (typeof l === 'string' ? l : l.name)),
  };
}

const ResolveIssueToPrRawSchema = z
  .object({
    closedByPullRequestsReferences: z
      .array(
        z
          .object({
            number: z.number().int().optional(),
            url: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    timelineItems: z
      .array(
        z
          .object({
            source: z
              .object({
                __typename: z.string().optional(),
                number: z.number().int().optional(),
                url: z.string().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

function extractPrNumberFromUrl(url: string | undefined): number | null {
  if (url == null) return null;
  const m = url.match(/\/pull\/(\d+)(?:\b|$)/);
  if (m == null) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

function parseResolveIssueToPr(stdout: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `gh returned malformed JSON for resolveIssueToPR: ${stdout.slice(0, 200)}`,
    );
  }
  const result = ResolveIssueToPrRawSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`gh issue view JSON shape mismatch: ${result.error.message}`);
  }
  const data = result.data;
  for (const ref of data.closedByPullRequestsReferences ?? []) {
    if (typeof ref.number === 'number') return ref.number;
    const fromUrl = extractPrNumberFromUrl(ref.url);
    if (fromUrl != null) return fromUrl;
  }
  for (const item of data.timelineItems ?? []) {
    const src = item.source;
    if (src == null) continue;
    if (typeof src.number === 'number') return src.number;
    const fromUrl = extractPrNumberFromUrl(src.url);
    if (fromUrl != null) return fromUrl;
  }
  return null;
}

function parseCheckRuns(stdout: string): CheckRunSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `gh returned malformed JSON for getPullRequestCheckRuns: ${stdout.slice(0, 200)}`,
    );
  }
  const arr = z.array(CheckRunRawSchema).safeParse(parsed);
  if (!arr.success) {
    throw new Error(`gh pr checks JSON shape mismatch: ${arr.error.message}`);
  }
  return arr.data.map<CheckRunSummary>((raw) => ({
    name: raw.name,
    state: normalizeCheckState(raw),
    conclusion: raw.conclusion ?? undefined,
    url: raw.detailsUrl ?? raw.link ?? undefined,
  }));
}

function failIfNonZero(result: { stdout: string; stderr: string; exitCode: number }, op: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`gh ${op} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
}

export class GhCliWrapper implements GhWrapper {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner = nodeChildProcessRunner) {
    this.runner = runner;
  }

  async listIssues(query: string, options: ListIssuesOptions = {}): Promise<Issue[]> {
    const limit = options.limit ?? 100;
    // `gh search issues` expects each query term/qualifier as its own argument.
    // Passing the whole query as a single arg makes gh fold trailing qualifiers
    // into the first one's quoted value (e.g. `repo:"o/r is:open"`), producing an
    // invalid query. Tokenize on whitespace, keeping "quoted phrases" intact.
    const terms = query.match(/"[^"]*"|\S+/g) ?? [];
    const args = [
      'search',
      'issues',
      ...terms,
      '--json',
      'number,title,state,labels,url,body,author,createdAt',
      '--limit',
      String(limit),
    ];
    if (options.repo != null) {
      args.push('--repo', options.repo);
    }
    const result = await this.runner('gh', args);
    failIfNonZero(result, 'search issues');
    return parseIssues(result.stdout);
  }

  async getIssue(repo: string, number: number): Promise<Issue> {
    const args = [
      'issue',
      'view',
      String(number),
      '--repo',
      repo,
      '--json',
      'number,title,state,labels,url,body,author,createdAt',
    ];
    const result = await this.runner('gh', args);
    failIfNonZero(result, 'issue view');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for getIssue: ${result.stdout.slice(0, 200)}`,
      );
    }
    const shape = IssueRawSchema.safeParse(parsed);
    if (!shape.success) {
      throw new Error(`gh getIssue JSON shape mismatch: ${shape.error.message}`);
    }
    const raw = shape.data;
    return {
      number: raw.number,
      title: raw.title,
      state: normalizeIssueState(raw.state),
      labels: raw.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      url: raw.url,
      body: raw.body ?? '',
      author: raw.author?.login != null ? { login: raw.author.login } : undefined,
      createdAt: raw.createdAt ?? '',
    };
  }

  async addLabels(repo: string, issue: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const args = ['issue', 'edit', String(issue), '--repo', repo];
    for (const label of labels) {
      args.push('--add-label', label);
    }
    const result = await this.runner('gh', args);
    failIfNonZero(result, 'issue edit (add-label)');
  }

  async removeLabels(repo: string, issue: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const args = ['issue', 'edit', String(issue), '--repo', repo];
    for (const label of labels) {
      args.push('--remove-label', label);
    }
    const result = await this.runner('gh', args);
    failIfNonZero(result, 'issue edit (remove-label)');
  }

  async addLabel(repo: string, issue: number, label: string): Promise<void> {
    return this.addLabels(repo, issue, [label]);
  }

  async removeLabel(repo: string, issue: number, label: string): Promise<void> {
    return this.removeLabels(repo, issue, [label]);
  }

  async getPullRequestCheckRuns(repo: string, prNumber: number): Promise<CheckRunSummary[]> {
    const args = [
      'pr',
      'checks',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'name,state,conclusion,detailsUrl',
    ];
    const result = await this.runner('gh', args);
    failIfNonZero(result, 'pr checks');
    return parseCheckRuns(result.stdout);
  }

  async resolveIssueToPR(repo: string, issueNumber: number): Promise<number | null> {
    const args = [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repo,
      '--json',
      'closedByPullRequestsReferences,timelineItems',
    ];
    const result = await this.runner('gh', args);
    failIfNonZero(result, 'issue view');
    return parseResolveIssueToPr(result.stdout);
  }

  async getPullRequest(repo: string, prNumber: number): Promise<PullRequestSummary> {
    const args = [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'number,state,mergedAt,closedAt,url,isDraft,labels',
    ];
    const result = await this.runner('gh', args);
    failIfNonZero(result, 'pr view');
    return parsePullRequest(result.stdout, prNumber);
  }

  async resolveIssueToPRRef(
    repo: string,
    issue: number,
  ): Promise<PullRequestRef | null> {
    const searchResult = await this.runner('gh', [
      'pr',
      'list',
      '--repo',
      repo,
      '--search',
      `linked:${issue}`,
      '--state',
      'open',
      '--json',
      'number,url,state,isDraft,headRefName',
      '--limit',
      '1',
    ]);
    failIfNonZero(searchResult, 'pr list (resolveIssueToPR search)');

    let parsed: unknown;
    try {
      parsed = JSON.parse(searchResult.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for resolveIssueToPR search: ${searchResult.stdout.slice(0, 200)}`,
      );
    }
    const arr = z.array(PullRequestRefRawSchema).safeParse(parsed);
    if (!arr.success) {
      throw new Error(
        `gh resolveIssueToPR search JSON shape mismatch: ${arr.error.message}`,
      );
    }
    if (arr.data.length > 0) {
      const raw = arr.data[0]!;
      return {
        number: raw.number,
        url: raw.url,
        state: normalizePullRequestState(raw.state),
        draft: raw.isDraft ?? false,
        headRefName: raw.headRefName,
      };
    }

    const fallbackResult = await this.runner('gh', [
      'issue',
      'view',
      String(issue),
      '--repo',
      repo,
      '--json',
      'closedByPullRequestsReferences',
    ]);
    failIfNonZero(fallbackResult, 'issue view (resolveIssueToPR fallback)');

    let fallbackParsed: unknown;
    try {
      fallbackParsed = JSON.parse(fallbackResult.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for resolveIssueToPR fallback: ${fallbackResult.stdout.slice(0, 200)}`,
      );
    }
    const fallbackShape = z
      .object({
        closedByPullRequestsReferences: z
          .array(
            z
              .object({
                number: z.number().int(),
                url: z.string(),
                state: z.string(),
                isDraft: z.boolean().optional(),
                headRefName: z.string(),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough()
      .safeParse(fallbackParsed);
    if (!fallbackShape.success) {
      throw new Error(
        `gh resolveIssueToPR fallback JSON shape mismatch: ${fallbackShape.error.message}`,
      );
    }
    const first = fallbackShape.data.closedByPullRequestsReferences[0];
    if (!first) return null;
    return {
      number: first.number,
      url: first.url,
      state: normalizePullRequestState(first.state),
      draft: first.isDraft ?? false,
      headRefName: first.headRefName,
    };
  }

  async getPullRequestDetail(
    repo: string,
    prNumber: number,
  ): Promise<PullRequestDetail> {
    const viewResult = await this.runner('gh', [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'number,title,url,baseRefName,headRefName,body,author,state,isDraft,labels',
    ]);
    failIfNonZero(viewResult, 'pr view');

    let viewParsed: unknown;
    try {
      viewParsed = JSON.parse(viewResult.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for getPullRequest: ${viewResult.stdout.slice(0, 200)}`,
      );
    }
    const detail = PullRequestDetailRawSchema.safeParse(viewParsed);
    if (!detail.success) {
      throw new Error(
        `gh getPullRequest JSON shape mismatch: ${detail.error.message}`,
      );
    }

    const diffResult = await this.runner('gh', [
      'pr',
      'diff',
      String(prNumber),
      '--repo',
      repo,
    ]);
    failIfNonZero(diffResult, 'pr diff');
    const { diff, diffTruncated } = applyDiffCap(diffResult.stdout);

    return {
      number: detail.data.number,
      title: detail.data.title,
      url: detail.data.url,
      base: detail.data.baseRefName,
      head: detail.data.headRefName,
      body: detail.data.body ?? '',
      author:
        detail.data.author?.login != null
          ? { login: detail.data.author.login }
          : null,
      state: normalizePullRequestState(detail.data.state),
      draft: detail.data.isDraft ?? false,
      labels: extractLabelNames(detail.data.labels),
      diff,
      diffTruncated,
    };
  }

  async mergePullRequest(
    repo: string,
    prNumber: number,
    _opts: { squash: true },
  ): Promise<MergeResult> {
    const mergeResult = await this.runner('gh', [
      'pr',
      'merge',
      String(prNumber),
      '--repo',
      repo,
      '--squash',
      '--delete-branch=false',
    ]);
    failIfNonZero(mergeResult, 'pr merge');

    const shaResult = await this.runner('gh', [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'mergeCommit',
    ]);
    if (shaResult.exitCode !== 0) {
      return { merged: true };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(shaResult.stdout);
    } catch {
      return { merged: true };
    }
    const shape = MergeCommitRawSchema.safeParse(parsed);
    if (!shape.success || !shape.data.mergeCommit?.oid) {
      return { merged: true };
    }
    return { merged: true, commitSha: shape.data.mergeCommit.oid };
  }

  async getRequiredCheckNames(
    repo: string,
    branch: string,
  ): Promise<RequiredChecksResult> {
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new Error(
        `getRequiredCheckNames: repo must be "owner/name", got: ${repo}`,
      );
    }
    const result = await this.runner('gh', [
      'api',
      `repos/${owner}/${name}/branches/${branch}/protection`,
    ]);
    if (result.exitCode !== 0) {
      const stderr = result.stderr;
      if (/HTTP\s+403|HTTP\s+404/.test(stderr)) {
        return { source: 'fallback-pr-checks', names: null };
      }
      throw new Error(
        `gh api branches/${branch}/protection failed (exit ${result.exitCode}): ${stderr.trim()}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for getRequiredCheckNames: ${result.stdout.slice(0, 200)}`,
      );
    }
    const shape = BranchProtectionRawSchema.safeParse(parsed);
    if (!shape.success) {
      throw new Error(
        `gh getRequiredCheckNames JSON shape mismatch: ${shape.error.message}`,
      );
    }
    return {
      source: 'branch-protection',
      names: shape.data.required_status_checks?.contexts ?? [],
    };
  }

  async fetchIssueLabels(repo: string, issue: number): Promise<IssueLabelsResult> {
    const result = await this.runner('gh', [
      'issue',
      'view',
      String(issue),
      '--repo',
      repo,
      '--json',
      'labels',
    ]);
    failIfNonZero(result, 'issue view (labels)');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for fetchIssueLabels: ${result.stdout.slice(0, 200)}`,
      );
    }
    const shape = IssueLabelsRawSchema.safeParse(parsed);
    if (!shape.success) {
      throw new Error(
        `gh fetchIssueLabels JSON shape mismatch: ${shape.error.message}`,
      );
    }
    return { labels: extractLabelNames(shape.data.labels) };
  }

  async fetchIssueState(repo: string, issue: number): Promise<IssueStateResult> {
    const result = await this.runner('gh', [
      'issue',
      'view',
      String(issue),
      '--repo',
      repo,
      '--json',
      'state,closedAt,labels,assignees,title',
    ]);
    failIfNonZero(result, 'issue view (state)');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for fetchIssueState: ${result.stdout.slice(0, 200)}`,
      );
    }
    const shape = IssueStateRawSchema.safeParse(parsed);
    if (!shape.success) {
      throw new Error(
        `gh fetchIssueState JSON shape mismatch: ${shape.error.message}`,
      );
    }
    return {
      state: normalizeIssueState(shape.data.state),
      closedAt: shape.data.closedAt ?? null,
      labels: extractLabelNames(shape.data.labels),
      assignees: shape.data.assignees.map((a) => a.login),
      title: shape.data.title,
    };
  }

  async postIssueComment(
    repo: string,
    issue: number,
    body: string,
  ): Promise<{ url: string }> {
    const result = await this.runner('gh', [
      'issue',
      'comment',
      String(issue),
      '--repo',
      repo,
      '--body',
      body,
    ]);
    failIfNonZero(result, 'issue comment');
    const url = result.stdout.trim().split(/\s+/).pop() ?? '';
    return { url };
  }

  async addAssignees(
    repo: string,
    issue: number,
    logins: string[],
  ): Promise<void> {
    for (const login of logins) {
      const result = await this.runner('gh', [
        'issue',
        'edit',
        String(issue),
        '--repo',
        repo,
        '--add-assignee',
        login,
      ]);
      failIfNonZero(result, 'issue edit (add-assignee)');
    }
  }

  async fetchIssueTimeline(
    repo: string,
    issue: number,
  ): Promise<unknown[]> {
    const result = await this.runner('gh', [
      'api',
      `repos/${repo}/issues/${issue}/timeline`,
      '--header',
      'Accept: application/vnd.github+json',
      '--paginate',
    ]);
    failIfNonZero(result, 'api issues timeline');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for fetchIssueTimeline: ${result.stdout.slice(0, 200)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `gh api timeline returned non-array JSON: ${result.stdout.slice(0, 200)}`,
      );
    }
    return z.array(TimelineEventRawSchema).parse(parsed);
  }

  async fetchIssueComments(
    repo: string,
    issue: number,
  ): Promise<IssueComment[]> {
    const result = await this.runner('gh', [
      'issue',
      'view',
      String(issue),
      '--repo',
      repo,
      '--json',
      'comments',
    ]);
    failIfNonZero(result, 'issue view (comments)');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for fetchIssueComments: ${result.stdout.slice(0, 200)}`,
      );
    }
    const shape = IssueCommentsRawSchema.safeParse(parsed);
    if (!shape.success) {
      throw new Error(
        `gh fetchIssueComments JSON shape mismatch: ${shape.error.message}`,
      );
    }
    return shape.data.comments.map<IssueComment>((c) => ({
      body: c.body,
      author: c.author?.login ?? '',
      createdAt: c.createdAt,
      url: c.url ?? '',
    }));
  }

  async getCurrentUser(): Promise<string> {
    const result = await this.runner('gh', ['api', 'user']);
    failIfNonZero(result, 'api user');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for getCurrentUser: ${result.stdout.slice(0, 200)}`,
      );
    }
    const shape = UserRawSchema.safeParse(parsed);
    if (!shape.success) {
      throw new Error(
        `gh getCurrentUser JSON shape mismatch: ${shape.error.message}`,
      );
    }
    return shape.data.login;
  }

  async findOpenPrForBranch(
    repo: string,
    branch: string,
  ): Promise<OpenPrForBranch | null> {
    const result = await this.runner('gh', [
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'url,number',
      '--limit',
      '1',
    ]);
    failIfNonZero(result, 'pr list');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for findOpenPrForBranch: ${result.stdout.slice(0, 200)}`,
      );
    }
    const shape = OpenPrForBranchRawSchema.safeParse(parsed);
    if (!shape.success) {
      throw new Error(
        `gh findOpenPrForBranch JSON shape mismatch: ${shape.error.message}`,
      );
    }
    if (shape.data.length === 0) return null;
    const first = shape.data[0]!;
    return { url: first.url, number: first.number };
  }

  async prDiffNames(repo: string, prNumber: number): Promise<string[]> {
    const result = await this.runner('gh', [
      'pr',
      'diff',
      String(prNumber),
      '--repo',
      repo,
      '--name-only',
    ]);
    failIfNonZero(result, 'pr diff (name-only)');
    return result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async prDiffPatch(repo: string, prNumber: number): Promise<string> {
    const result = await this.runner('gh', [
      'pr',
      'diff',
      String(prNumber),
      '--repo',
      repo,
      '--patch',
    ]);
    failIfNonZero(result, 'pr diff (patch)');
    return result.stdout;
  }
}

export type { CommandRunner } from './command-runner.js';
