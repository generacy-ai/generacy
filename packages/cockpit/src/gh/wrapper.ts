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

export interface PullRequestSummary {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt?: string;
  closedAt?: string;
  url: string;
  isDraft: boolean;
  labels: string[];
}

export interface GhWrapper {
  listIssues(query: string, options?: ListIssuesOptions): Promise<Issue[]>;
  addLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  removeLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  getPullRequestCheckRuns(repo: string, prNumber: number): Promise<CheckRunSummary[]>;
  resolveIssueToPR(repo: string, issueNumber: number): Promise<number | null>;
  getPullRequest(repo: string, prNumber: number): Promise<PullRequestSummary>;
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

function normalizeIssueState(state: string): 'OPEN' | 'CLOSED' {
  return state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
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
    const args = [
      'search',
      'issues',
      query,
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
}

export type { CommandRunner } from './command-runner.js';
