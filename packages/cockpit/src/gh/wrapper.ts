import { z } from 'zod';
import {
  nodeChildProcessRunner,
  type CommandRunner,
} from './command-runner.js';

export interface Issue {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;
  labels: string[];
  url: string;
  body: string;
  author?: { login: string };
  createdAt: string;
}

export interface CheckRunSummary {
  name: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
  url?: string;
}

export interface GhWrapperLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const defaultGhWrapperLogger: GhWrapperLogger = {
  warn(obj, msg) {
    // eslint-disable-next-line no-console
    console.warn(msg, obj);
  },
};

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

/**
 * Named union of the three resolution tiers used by `resolveIssueToPRRef`.
 * Consumers must not depend on the specific string values beyond equality — they
 * are stable identifiers, not human copy. Serialized verbatim into JSON payloads.
 */
export type LinkMethod = 'closing-refs' | 'branch-name' | 'pr-body';

/**
 * Reduced-shape PR record for multi-candidate ambiguity/only-drafts payloads.
 * Distinct from `PullRequestRef` (which has `state`) — the candidate list is
 * always open-PRs-only, so `state` is implicit.
 */
export interface PrCandidate {
  number: number;
  url: string;
  isDraft: boolean;
  headRefName: string;
}

/**
 * Discriminated-union result of `resolveIssueToPRRef`.
 *
 * Invariants (enforced by the resolver; callers may `assert`/exhaust but do
 * not re-check):
 *   I-1: `kind === 'ambiguous'`   ⇒ `candidates.length >= 2` ∧ ∀c: c.draft === false
 *   I-2: `kind === 'pr-is-draft'` ⇒ `candidates.length >= 1` ∧ ∀c: c.draft === true
 *   I-3: `kind === 'resolved'`    ⇒ `ref.draft === false` ∧ `ref.state === 'OPEN'`
 *   I-4: `kind === 'unresolved'`  ⇒ no other fields present (zero-field variant)
 *   I-5: `linkMethod` is one of 'closing-refs' | 'branch-name' | 'pr-body' —
 *        never undefined on the three non-`unresolved` kinds.
 */
export type PullRequestRefResolution =
  | { kind: 'resolved'; ref: PullRequestRef; linkMethod: LinkMethod }
  | { kind: 'ambiguous'; candidates: PullRequestRef[]; linkMethod: LinkMethod }
  | { kind: 'pr-is-draft'; candidates: PullRequestRef[]; linkMethod: LinkMethod }
  | { kind: 'unresolved' };

export interface PullRequestDetail {
  number: number;
  title: string;
  url: string;
  base: string;
  head: string;
  headRepositoryOwner: string | null;
  body: string;
  author: { login: string } | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  labels: string[];
  diff: string;
  diffTruncated: boolean;
}

/**
 * PR detail selection-set fetched via `gh api graphql`. Used by the `cockpit
 * merge --pr <n>` escape hatch. Distinct from `PullRequestDetail` because the
 * `--json` serializer is the exact contract class #913 is escaping.
 */
export interface PullRequestGraphqlDetail {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  isDraft: boolean;
  /** GitHub `MergeStateStatus` — captured for future gates, not consumed today. */
  mergeStateStatus: string;
  /** Every issue this PR declares as a closing target — FR-006a linkage source. */
  closingIssuesReferences: Array<{
    number: number;
    /** `owner/name` — for cross-repo comparison to `<ref>`. */
    nameWithOwner: string;
  }>;
}

export interface DeleteHeadRefResult {
  outcome: 'deleted' | 'already-gone' | 'delete-failed';
  stderr?: string;
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
  stateReason: string | null;
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
  resolveIssueToPRRef(repo: string, issue: number): Promise<PullRequestRefResolution>;
  getPullRequestDetail(repo: string, prNumber: number): Promise<PullRequestDetail>;
  getPullRequestGraphqlDetail(
    repo: string,
    prNumber: number,
  ): Promise<PullRequestGraphqlDetail>;
  mergePullRequest(
    repo: string,
    prNumber: number,
    opts: { squash: true },
  ): Promise<MergeResult>;
  deleteHeadRef(
    repo: string,
    headRef: string,
  ): Promise<DeleteHeadRefResult>;
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
  stateReason: z.string().nullable().optional(),
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

// FR-004 — 2.96.0 minimal shape tolerance for tier-1 initial parse.
// Only `number` and `url` are read; both `.optional()` so gh 2.96.0's
// `{id, number, repository, url}` and gh 2.95.x's rich shape both parse.
// `.passthrough()` — extra fields present in gh 2.95.x are silently accepted.
const Tier1InitialRefSchema = z
  .object({
    number: z.number().int().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const Tier1InitialResponseSchema = z
  .object({
    closedByPullRequestsReferences: z.array(Tier1InitialRefSchema).default([]),
  })
  .passthrough();

// FR-002 — per-PR nodes returned by the tier-1 follow-up graphql query.
// Not `.passthrough()` — the query selects exactly these fields; extras
// would signal server-side drift worth flagging.
const Tier1FollowupRefSchema = z.object({
  number: z.number().int(),
  state: z.string(),
  headRefName: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
});

const Tier1FollowupResponseSchema = z.object({
  data: z.object({
    repository: z
      .object({})
      .catchall(Tier1FollowupRefSchema.nullable()),
  }),
});

// FR-006 — return shape of getPullRequestGraphqlDetail.
const PrGraphqlDetailSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z
        .object({
          state: z.string(),
          headRefName: z.string(),
          isDraft: z.boolean(),
          mergeStateStatus: z.string(),
          closingIssuesReferences: z.object({
            nodes: z.array(
              z.object({
                number: z.number().int(),
                repository: z.object({ nameWithOwner: z.string() }),
              }),
            ),
          }),
        })
        .nullable(),
    }),
  }),
});

// FR-002a — single-shot retry backoff. Module-level so tests can spy on the
// gap between attempt 1 and attempt 2.
const TIER1_RETRY_BACKOFF_MS = 1000;

// FR-009 — payload excerpt cap per clarify Q2→B (fits 2–3 minimal-shape refs).
const SHAPE_MISMATCH_EXCERPT_CHARS = 512;

// FR-006 — explicit graphql selection set for the `--pr` PR detail fetch.
const PR_DETAIL_QUERY = /* graphql */ `
  query CockpitPrDetail($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        state
        headRefName
        isDraft
        mergeStateStatus
        closingIssuesReferences(first: 20) {
          nodes {
            number
            repository { nameWithOwner }
          }
        }
      }
    }
  }
`;

// FR-002 — dynamic aliased-fields builder for the tier-1 follow-up query.
// One aliased selection per requested PR number: `pr0: pullRequest(number: N0) { ... }`.
// See contracts/graphql-selection-set.md §2. Numbers come from a zod-validated
// integer parse of gh's own output; injection surface is zero.
function buildTier1FollowupQuery(numbers: number[]): string {
  const selections = numbers
    .map(
      (n, i) =>
        `    pr${i}: pullRequest(number: ${n}) { number state headRefName isDraft url }`,
    )
    .join('\n');
  return `query CockpitTier1Followup($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${selections}
  }
}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// FR-010 — reads first line of `gh --version`, degrades to `'unknown'` on
// non-zero exit or thrown runner. Never throws.
async function captureGhVersion(runner: CommandRunner): Promise<string> {
  try {
    const r = await runner('gh', ['--version']);
    if (r.exitCode !== 0) return 'unknown';
    const firstLine = r.stdout.split('\n')[0] ?? '';
    return firstLine.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// FR-009 — single-line message with 512-char payload excerpt and gh version.
function formatShapeMismatchError(
  siteLabel: string,
  rawPayload: string,
  errorMessage: string,
  ghVersion: string,
): Error {
  const excerpt = rawPayload.slice(0, SHAPE_MISMATCH_EXCERPT_CHARS);
  return new Error(
    `gh ${siteLabel} JSON shape mismatch: ${errorMessage} ` +
      `(gh version: ${ghVersion}; payload excerpt: ${excerpt})`,
  );
}

const PullRequestDetailRawSchema = z
  .object({
    number: z.number().int(),
    title: z.string(),
    url: z.string(),
    baseRefName: z.string(),
    headRefName: z.string(),
    headRepositoryOwner: z
      .object({ login: z.string() })
      .passthrough()
      .nullable()
      .optional(),
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
  stateReason: z.string().nullable().optional(),
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

function normalizeStateReason(
  reason: string | null | undefined,
): 'COMPLETED' | 'NOT_PLANNED' | null {
  if (reason === 'COMPLETED') return 'COMPLETED';
  if (reason === 'NOT_PLANNED') return 'NOT_PLANNED';
  return null;
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
    case 'CANCEL':
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
    stateReason: normalizeStateReason(raw.stateReason),
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
    url: raw.link ?? undefined,
  }));
}

function evaluateTier(
  candidates: PullRequestRef[],
  linkMethod: LinkMethod,
): PullRequestRefResolution | null {
  const nonDrafts = candidates.filter((p) => !p.draft);
  if (nonDrafts.length === 1) {
    return { kind: 'resolved', ref: nonDrafts[0]!, linkMethod };
  }
  if (nonDrafts.length >= 2) {
    return { kind: 'ambiguous', candidates: nonDrafts, linkMethod };
  }
  const drafts = candidates.filter((p) => p.draft);
  if (drafts.length >= 1) {
    return { kind: 'pr-is-draft', candidates: drafts, linkMethod };
  }
  return null;
}

function failIfNonZero(result: { stdout: string; stderr: string; exitCode: number }, op: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`gh ${op} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
}

export class GhCliWrapper implements GhWrapper {
  private readonly runner: CommandRunner;
  private readonly logger: GhWrapperLogger;

  constructor(
    runner: CommandRunner = nodeChildProcessRunner,
    logger: GhWrapperLogger = defaultGhWrapperLogger,
  ) {
    this.runner = runner;
    this.logger = logger;
  }

  async listIssues(query: string, options: ListIssuesOptions = {}): Promise<Issue[]> {
    const limit = options.limit ?? 100;
    // `gh search issues` expects each query term/qualifier as its own argument.
    // Passing the whole query as a single arg makes gh fold trailing qualifiers
    // into the first one's quoted value (e.g. `repo:"o/r is:open"`), producing an
    // invalid query. Tokenize on whitespace, keeping "quoted phrases" intact.
    const terms = query.match(/"[^"]*"|\S+/g) ?? [];
    // `gh search issues` does NOT support `stateReason` on `--json` (verified
    // by json-field-drift.test.ts against the real gh binary). Closed issues
    // returned from search paths surface with `stateReason: null`; the render
    // defaults to the merged/closed variant (see fmtRow). `getIssue` (via
    // `gh issue view`) does accept `stateReason` and propagates it verbatim.
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
      'number,title,state,stateReason,labels,url,body,author,createdAt',
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
      stateReason: normalizeStateReason(raw.stateReason),
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
      'name,state,bucket,link',
    ];
    const result = await this.runner('gh', args);
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      if (stderr.toLowerCase().includes('no checks reported')) {
        return [];
      }
      this.logger.warn(
        { repo, prNumber, ghStderr: stderr },
        'gh pr checks failed',
      );
      throw new Error(`gh pr checks failed (exit ${result.exitCode}): ${stderr}`);
    }
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
      'closedByPullRequestsReferences',
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
  ): Promise<PullRequestRefResolution> {
    const tier1 = await this.queryTier1ClosingRefs(repo, issue);
    const t1 = evaluateTier(tier1, 'closing-refs');
    if (t1 != null) return t1;

    const tier2 = await this.queryTier2BranchName(repo, issue);
    const t2 = evaluateTier(tier2, 'branch-name');
    if (t2 != null) return t2;

    const tier3 = await this.queryTier3PrBody(repo, issue);
    const t3 = evaluateTier(tier3, 'pr-body');
    if (t3 != null) return t3;

    return { kind: 'unresolved' };
  }

  private async queryTier1ClosingRefs(
    repo: string,
    issue: number,
  ): Promise<PullRequestRef[]> {
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new Error(
        `queryTier1ClosingRefs: repo must be "owner/name", got: ${repo}`,
      );
    }

    // (1) FR-004 — initial call: parse only what the 2.96.0 minimal shape guarantees.
    const initial = await this.runner('gh', [
      'issue',
      'view',
      String(issue),
      '--repo',
      repo,
      '--json',
      'closedByPullRequestsReferences',
    ]);
    failIfNonZero(initial, 'issue view (resolveIssueToPRRef tier1 initial)');

    let initialParsed: unknown;
    try {
      initialParsed = JSON.parse(initial.stdout);
    } catch {
      const ghVer = await captureGhVersion(this.runner);
      throw formatShapeMismatchError(
        'resolveIssueToPRRef tier1 initial JSON.parse',
        initial.stdout,
        'malformed JSON',
        ghVer,
      );
    }

    const initialShape = Tier1InitialResponseSchema.safeParse(initialParsed);
    if (!initialShape.success) {
      const ghVer = await captureGhVersion(this.runner);
      throw formatShapeMismatchError(
        'resolveIssueToPRRef tier1 initial shape',
        initial.stdout,
        initialShape.error.message,
        ghVer,
      );
    }

    // Extract PR numbers (number-first, url-fallback per parseResolveIssueToPr pattern).
    const numbers: number[] = [];
    for (const ref of initialShape.data.closedByPullRequestsReferences) {
      if (typeof ref.number === 'number') {
        numbers.push(ref.number);
        continue;
      }
      const fromUrl = extractPrNumberFromUrl(ref.url);
      if (fromUrl != null) numbers.push(fromUrl);
    }

    // Fast path: no closing refs → tier-1 returns no candidates, resolver falls
    // through to tier-2 as it always has. (This is NOT the FR-002a hard-fail
    // path — no follow-up call is made, no failure occurred.)
    if (numbers.length === 0) return [];

    // (2) FR-002 — follow-up graphql call with FR-002a single-shot retry.
    const perPr = await this.queryTier1FollowupGraphql(owner, name, numbers);

    // (3) FR-003 — filter to OPEN before returning refs to the merge caller.
    const refs: PullRequestRef[] = [];
    for (const n of numbers) {
      const detail = perPr.get(n);
      if (detail == null) continue; // graphql omitted / null-aliased (deleted PR).
      if (normalizePullRequestState(detail.state) !== 'OPEN') continue;
      refs.push({
        number: detail.number,
        url: detail.url,
        state: 'OPEN',
        draft: detail.isDraft,
        headRefName: detail.headRefName,
      });
    }
    return refs;
  }

  // FR-002a — one retry with TIER1_RETRY_BACKOFF_MS backoff, then hard-fail.
  // Never falls through to tier-2 (would risk selecting a different PR);
  // never filters to a "successful subset" (silent-wrong outcome).
  private async queryTier1FollowupGraphql(
    owner: string,
    name: string,
    numbers: number[],
  ): Promise<
    Map<
      number,
      { number: number; state: string; headRefName: string; isDraft: boolean; url: string }
    >
  > {
    try {
      return await this.tier1FollowupOnce(owner, name, numbers);
    } catch {
      await sleep(TIER1_RETRY_BACKOFF_MS);
      try {
        return await this.tier1FollowupOnce(owner, name, numbers);
      } catch (second) {
        throw new Error(
          `gh resolveIssueToPRRef tier1 follow-up graphql failed after 1 retry: ${
            (second as Error).message
          }`,
        );
      }
    }
  }

  private async tier1FollowupOnce(
    owner: string,
    name: string,
    numbers: number[],
  ): Promise<
    Map<
      number,
      { number: number; state: string; headRefName: string; isDraft: boolean; url: string }
    >
  > {
    const query = buildTier1FollowupQuery(numbers);
    const result = await this.runner('gh', [
      'api',
      'graphql',
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${name}`,
      '-f',
      `query=${query}`,
    ]);
    failIfNonZero(result, 'api graphql (resolveIssueToPRRef tier1 follow-up)');

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      const ghVer = await captureGhVersion(this.runner);
      throw formatShapeMismatchError(
        'resolveIssueToPRRef tier1 follow-up JSON.parse',
        result.stdout,
        'malformed JSON',
        ghVer,
      );
    }

    const shape = Tier1FollowupResponseSchema.safeParse(parsed);
    if (!shape.success) {
      const ghVer = await captureGhVersion(this.runner);
      throw formatShapeMismatchError(
        'resolveIssueToPRRef tier1 follow-up shape',
        result.stdout,
        shape.error.message,
        ghVer,
      );
    }

    const out = new Map<
      number,
      { number: number; state: string; headRefName: string; isDraft: boolean; url: string }
    >();
    for (const value of Object.values(shape.data.data.repository)) {
      if (value == null) continue;
      out.set(value.number, value);
    }
    return out;
  }

  private async queryTier2BranchName(
    repo: string,
    issue: number,
  ): Promise<PullRequestRef[]> {
    return this.queryPrListSearch(
      repo,
      `head:${issue}-`,
      'pr list (resolveIssueToPRRef tier2 branch-name)',
    );
  }

  private async queryTier3PrBody(
    repo: string,
    issue: number,
  ): Promise<PullRequestRef[]> {
    return this.queryPrListSearch(
      repo,
      `${issue} in:body`,
      'pr list (resolveIssueToPRRef tier3 pr-body)',
    );
  }

  private async queryPrListSearch(
    repo: string,
    search: string,
    op: string,
  ): Promise<PullRequestRef[]> {
    const result = await this.runner('gh', [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--search',
      search,
      '--json',
      'number,url,state,isDraft,headRefName',
      '--limit',
      '100',
    ]);
    failIfNonZero(result, op);

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `gh returned malformed JSON for ${op}: ${result.stdout.slice(0, 200)}`,
      );
    }
    const arr = z.array(PullRequestRefRawSchema).safeParse(parsed);
    if (!arr.success) {
      throw new Error(`gh ${op} JSON shape mismatch: ${arr.error.message}`);
    }
    return arr.data
      .map<PullRequestRef>((raw) => ({
        number: raw.number,
        url: raw.url,
        state: normalizePullRequestState(raw.state),
        draft: raw.isDraft ?? false,
        headRefName: raw.headRefName,
      }))
      .filter((p) => p.state === 'OPEN');
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
      'number,title,url,baseRefName,headRefName,headRepositoryOwner,body,author,state,isDraft,labels',
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
      headRepositoryOwner: detail.data.headRepositoryOwner?.login ?? null,
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

  async getPullRequestGraphqlDetail(
    repo: string,
    prNumber: number,
  ): Promise<PullRequestGraphqlDetail> {
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new Error(
        `getPullRequestGraphqlDetail: repo must be "owner/name", got: ${repo}`,
      );
    }

    const result = await this.runner('gh', [
      'api',
      'graphql',
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${name}`,
      '-F',
      `number=${prNumber}`,
      '-f',
      `query=${PR_DETAIL_QUERY}`,
    ]);
    failIfNonZero(result, 'api graphql (getPullRequestGraphqlDetail)');

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      const ghVer = await captureGhVersion(this.runner);
      throw formatShapeMismatchError(
        'getPullRequestGraphqlDetail JSON.parse',
        result.stdout,
        'malformed JSON',
        ghVer,
      );
    }

    const shape = PrGraphqlDetailSchema.safeParse(parsed);
    if (!shape.success) {
      const ghVer = await captureGhVersion(this.runner);
      throw formatShapeMismatchError(
        'getPullRequestGraphqlDetail shape',
        result.stdout,
        shape.error.message,
        ghVer,
      );
    }

    const pr = shape.data.data.repository.pullRequest;
    if (pr == null) {
      throw new Error(`PR #${prNumber} not found in ${repo}`);
    }

    return {
      state: normalizePullRequestState(pr.state),
      headRefName: pr.headRefName,
      isDraft: pr.isDraft,
      mergeStateStatus: pr.mergeStateStatus,
      closingIssuesReferences: pr.closingIssuesReferences.nodes.map((n) => ({
        number: n.number,
        nameWithOwner: n.repository.nameWithOwner,
      })),
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

  async deleteHeadRef(
    repo: string,
    headRef: string,
  ): Promise<DeleteHeadRefResult> {
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new Error(
        `deleteHeadRef: repo must be "owner/name", got: ${repo}`,
      );
    }
    const result = await this.runner('gh', [
      'api',
      '-X',
      'DELETE',
      `repos/${owner}/${name}/git/refs/heads/${headRef}`,
    ]);
    if (result.exitCode === 0) {
      return { outcome: 'deleted' };
    }
    const stderr = result.stderr.trim();
    if (/HTTP\s+422|HTTP\s+404/.test(stderr)) {
      return { outcome: 'already-gone' };
    }
    return { outcome: 'delete-failed', stderr };
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
      'state,stateReason,closedAt,labels,assignees,title',
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
      stateReason: shape.data.stateReason ?? null,
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
