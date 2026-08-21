/**
 * GitHubClient implementation using the gh CLI.
 * Uses the GitHub CLI for all GitHub API operations and git for local operations.
 */
import type {
  GitHubClient,
  IssueUpdate,
  PRCreate,
  PRUpdate,
  MergeResult,
  CommitResult,
  PushResult,
  GitStatus,
  LabelDefinition,
} from './interface.js';
import type {
  Issue,
  PullRequest,
  Comment,
  Label,
  RepoInfo,
  ConflictInfo,
  Review,
  ReviewSubmissionState,
  ReviewThread,
  CreateReviewInput,
  PullRequestFile,
  CiRun,
  CiConclusion,
} from '../../../types/github.js';
import { executeCommand, parseJSONSafe } from '../../cli-utils.js';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Thrown by `executeGh()` when the gh CLI's stderr signals HTTP 401 or 403.
 * Callers (label/PR-feedback monitors) catch this to drive auth-health state.
 * See #861 for the 403 widening (GraphQL scope-denial paths).
 */
export class GhAuthError extends Error {
  constructor(
    public readonly statusCode: 401 | 403,
    public readonly stderr: string,
    message?: string,
  ) {
    super(message ?? `gh authentication failed (HTTP ${statusCode}): ${stderr}`);
    this.name = 'GhAuthError';
  }
}

/**
 * Extract the first HTTP status code from gh CLI stderr.
 * gh 2.x emits either `HTTP 401: Bad credentials` (GraphQL path) or
 * `gh: ... (HTTP 401)` (REST path) — both match `/HTTP\s+(\d{3})/i`.
 */
export function parseGhStatusCode(stderr: string): number | undefined {
  const match = stderr.match(/HTTP\s+(\d{3})/i);
  if (!match) return undefined;
  return Number.parseInt(match[1]!, 10);
}

/**
 * GitHubClient implementation using gh CLI and git commands
 */
export class GhCliGitHubClient implements GitHubClient {
  private workdir: string;
  private tokenProvider?: () => Promise<string | undefined>;

  constructor(
    workdir?: string,
    tokenProvider?: () => Promise<string | undefined>,
  ) {
    this.workdir = workdir ?? process.cwd();
    this.tokenProvider = tokenProvider;
  }

  /**
   * Resolve the env override passed to the `gh` subprocess.
   *
   * Invariant: provider present ⇒ `GH_TOKEN` is always set, never `undefined`.
   * This prevents the `gh` subprocess from inheriting the orchestrator's
   * ambient `GH_TOKEN` (which, on wizard clusters, is the expired static
   * token from `wizard-credentials.env`). When the provider throws
   * `JitTokenError`, the throw propagates and the caller's loop-boundary
   * catch records the failure and skips the gh call — no subprocess is
   * spawned. See `specs/777-severity-high-773-not/contracts/gh-cli-env-override.md`.
   *
   * No provider ⇒ returns `undefined` so the subprocess inherits ambient env
   * (legacy behavior for truly-unconfigured clusters).
   */
  private async resolveTokenEnv(): Promise<Record<string, string> | undefined> {
    if (!this.tokenProvider) return undefined;
    const token = await this.tokenProvider();
    return { GH_TOKEN: token ?? '' };
  }

  private async executeGh(args: string[]) {
    const env = await this.resolveTokenEnv();
    const result = await executeCommand('gh', args, { cwd: this.workdir, env });
    if (result.exitCode !== 0) {
      const code = parseGhStatusCode(result.stderr);
      if (code === 401 || code === 403) {
        throw new GhAuthError(code, result.stderr);
      }
    }
    return result;
  }

  // ==========================================================================
  // Repository Info
  // ==========================================================================

  async getRepoInfo(): Promise<RepoInfo> {
    const result = await this.executeGh([
      'repo', 'view',
      '--json', 'owner,name,defaultBranchRef',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get repo info: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as {
      owner: { login: string };
      name: string;
      defaultBranchRef: { name: string };
    } | null;

    if (!data) {
      throw new Error('Failed to parse repo info');
    }

    return {
      owner: data.owner.login,
      repo: data.name,
      default_branch: data.defaultBranchRef.name,
    };
  }

  // ==========================================================================
  // Issue Operations
  // ==========================================================================

  async getIssue(owner: string, repo: string, number: number): Promise<Issue> {
    const result = await this.executeGh([
      'issue', 'view', String(number),
      '-R', `${owner}/${repo}`,
      '--json', 'number,title,body,state,labels,assignees,milestone,createdAt,updatedAt',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get issue #${number}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Record<string, unknown> | null;
    if (!data) {
      throw new Error('Failed to parse issue data');
    }

    return {
      number: data['number'] as number,
      title: data['title'] as string,
      body: data['body'] as string ?? '',
      state: (data['state'] as string).toLowerCase() as 'open' | 'closed',
      labels: ((data['labels'] as Array<{ name: string; color: string; description?: string }>) ?? []).map(l => ({
        name: l.name,
        color: l.color,
        description: l.description,
      })),
      assignees: ((data['assignees'] as Array<{ login: string }>) ?? []).map(a => a.login),
      milestone: data['milestone'] ? {
        number: (data['milestone'] as { number: number }).number,
        title: (data['milestone'] as { title: string }).title,
        state: 'open' as const,
      } : undefined,
      created_at: data['createdAt'] as string,
      updated_at: data['updatedAt'] as string,
    };
  }

  async getIssueLabels(owner: string, repo: string, number: number): Promise<string[]> {
    const result = await this.executeGh([
      'issue', 'view', String(number),
      '-R', `${owner}/${repo}`,
      '--json', 'labels',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get labels for issue #${number}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Record<string, unknown> | null;
    if (!data) {
      throw new Error('Failed to parse issue label data');
    }

    const labels = (data['labels'] as Array<{ name: string }> | undefined) ?? [];
    return labels.map(l => l.name);
  }

  async listIssuesWithLabel(owner: string, repo: string, label: string): Promise<Issue[]> {
    const result = await this.executeGh([
      'issue', 'list',
      '-R', `${owner}/${repo}`,
      '--label', label,
      '--state', 'open',
      '--json', 'number,title,body,state,labels,assignees,milestone,createdAt,updatedAt',
      '--limit', '100',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list issues with label "${label}": ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Array<Record<string, unknown>> | null;
    if (!data) {
      return [];
    }

    return data.map(item => ({
      number: item['number'] as number,
      title: item['title'] as string,
      body: item['body'] as string ?? '',
      state: ((item['state'] as string) ?? 'open').toLowerCase() as 'open' | 'closed',
      labels: ((item['labels'] as Array<{ name: string; color: string; description?: string }>) ?? []).map(l => ({
        name: l.name,
        color: l.color,
        description: l.description,
      })),
      assignees: ((item['assignees'] as Array<{ login: string }>) ?? []).map(a => a.login),
      milestone: item['milestone'] ? {
        number: (item['milestone'] as { number: number }).number,
        title: (item['milestone'] as { title: string }).title,
        state: 'open' as const,
      } : undefined,
      created_at: item['createdAt'] as string,
      updated_at: item['updatedAt'] as string,
    }));
  }

  async updateIssue(owner: string, repo: string, number: number, data: IssueUpdate): Promise<void> {
    const args = ['issue', 'edit', String(number), '-R', `${owner}/${repo}`];

    if (data.title) {
      args.push('--title', data.title);
    }
    if (data.body !== undefined) {
      args.push('--body', data.body);
    }
    if (data.labels) {
      // Clear existing labels and add new ones
      args.push('--remove-label', '*');
      for (const label of data.labels) {
        args.push('--add-label', label);
      }
    }
    if (data.assignees) {
      for (const assignee of data.assignees) {
        args.push('--add-assignee', assignee);
      }
    }

    const result = await this.executeGh(args);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to update issue #${number}: ${result.stderr}`);
    }
  }

  async addIssueComment(owner: string, repo: string, number: number, body: string): Promise<Comment> {
    const result = await this.executeGh([
      'issue', 'comment', String(number),
      '-R', `${owner}/${repo}`,
      '--body', body,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to add comment to issue #${number}: ${result.stderr}`);
    }

    // gh doesn't return the comment details, so we need to fetch the latest comment
    // #842 audit: whitelist — fetches the bot's own just-posted comment for
    // metadata; content is not surfaced to any agent.
    const comments = await this.getIssueComments(owner, repo, number);
    const latest = comments[comments.length - 1];
    if (!latest) {
      throw new Error('Failed to get created comment');
    }
    return latest;
  }

  async getIssueComments(owner: string, repo: string, number: number): Promise<Comment[]> {
    // Use REST API to get numeric comment IDs (gh issue view --json returns GraphQL node IDs)
    const result = await this.executeGh([
      'api',
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      '--paginate',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get comments for issue #${number}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Array<{
      id: number;
      body: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
      author_association?: string;
    }> | null;

    if (!data) {
      return [];
    }

    return data.map(c => ({
      id: c.id,
      body: c.body,
      author: c.user.login,
      created_at: c.created_at,
      updated_at: c.updated_at,
      authorAssociation: c.author_association,
    }));
  }

  async getIssueCommentsWithViewerAuth(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Comment[]> {
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      comments(first: 100) {
        nodes {
          databaseId
          body
          createdAt
          updatedAt
          author { login }
          authorAssociation
          viewerDidAuthor
        }
      }
    }
  }
}`;

    const result = await this.executeGh([
      'api', 'graphql',
      '-f', `query=${query}`,
      '-F', `owner=${owner}`,
      '-F', `repo=${repo}`,
      '-F', `number=${number}`,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get issue comments for issue #${number}: ${result.stderr}`);
    }

    const parsed = parseJSONSafe(result.stdout) as {
      data?: {
        repository?: {
          issue?: {
            comments?: {
              nodes?: Array<{
                databaseId: number;
                body: string;
                createdAt: string;
                updatedAt: string;
                author: { login: string } | null;
                authorAssociation: string | null;
                viewerDidAuthor: boolean | null;
              }>;
            };
          };
        };
      };
    } | null;

    const nodes = parsed?.data?.repository?.issue?.comments?.nodes;
    if (!nodes) return [];

    return nodes.map((c) => {
      const comment: Comment = {
        id: c.databaseId,
        body: c.body,
        author: c.author?.login ?? '',
        created_at: c.createdAt,
        updated_at: c.updatedAt,
      };
      if (c.authorAssociation !== null && c.authorAssociation !== undefined) {
        comment.authorAssociation = c.authorAssociation;
      }
      if (c.viewerDidAuthor !== null && c.viewerDidAuthor !== undefined) {
        comment.viewerDidAuthor = c.viewerDidAuthor;
      }
      return comment;
    });
  }

  async updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void> {
    // gh CLI doesn't have a direct command to edit comments, use API
    const result = await this.executeGh([
      'api',
      '-X', 'PATCH',
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      '-f', `body=${body}`,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to update comment ${commentId}: ${result.stderr}`);
    }
  }

  // ==========================================================================
  // PR Operations
  // ==========================================================================

  async createPullRequest(owner: string, repo: string, data: PRCreate): Promise<PullRequest> {
    const args = [
      'pr', 'create',
      '-R', `${owner}/${repo}`,
      '--title', data.title,
      '--body', data.body ?? '',
      '--head', data.head,
      '--base', data.base,
    ];

    if (data.draft) {
      args.push('--draft');
    }

    const result = await this.executeGh(args);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create PR: ${result.stderr}`);
    }

    // gh pr create outputs the PR URL on stdout (--json is not supported)
    const urlMatch = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
    if (urlMatch) {
      return {
        number: parseInt(urlMatch[1]!, 10),
        title: data.title,
        body: data.body ?? '',
        state: 'open',
        draft: data.draft ?? false,
        head: { ref: data.head, sha: '', repo: `${owner}/${repo}` },
        base: { ref: data.base, sha: '', repo: `${owner}/${repo}` },
        labels: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }

    // Fallback: try parsing as JSON in case future gh versions add support
    const parsed = parseJSONSafe(result.stdout) as Record<string, unknown> | null;
    if (!parsed) {
      throw new Error('Failed to parse PR creation response');
    }

    return {
      number: parsed['number'] as number,
      title: parsed['title'] as string,
      body: parsed['body'] as string ?? '',
      state: 'open',
      draft: parsed['isDraft'] as boolean ?? false,
      head: { ref: parsed['headRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      base: { ref: parsed['baseRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      labels: [],
      created_at: parsed['createdAt'] as string,
      updated_at: parsed['updatedAt'] as string,
    };
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const result = await this.executeGh([
      'pr', 'view', String(number),
      '-R', `${owner}/${repo}`,
      '--json', 'number,title,body,state,isDraft,headRefName,baseRefName,labels,mergeable,createdAt,updatedAt',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get PR #${number}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Record<string, unknown> | null;
    if (!data) {
      throw new Error('Failed to parse PR data');
    }

    const state = (data['state'] as string).toLowerCase();

    return {
      number: data['number'] as number,
      title: data['title'] as string,
      body: data['body'] as string ?? '',
      state: state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open',
      draft: data['isDraft'] as boolean ?? false,
      head: { ref: data['headRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      base: { ref: data['baseRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      labels: ((data['labels'] as Array<{ name: string; color: string }>) ?? []).map(l => ({
        name: l.name,
        color: l.color,
      })),
      mergeable: data['mergeable'] as boolean,
      created_at: data['createdAt'] as string,
      updated_at: data['updatedAt'] as string,
    };
  }

  async updatePullRequest(owner: string, repo: string, number: number, data: PRUpdate): Promise<void> {
    const args = ['pr', 'edit', String(number), '-R', `${owner}/${repo}`];

    if (data.title) {
      args.push('--title', data.title);
    }
    if (data.body !== undefined) {
      args.push('--body', data.body);
    }

    const result = await this.executeGh(args);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to update PR #${number}: ${result.stderr}`);
    }

    // Handle state change separately
    if (data.state === 'closed') {
      const closeResult = await this.executeGh([
        'pr', 'close', String(number),
        '-R', `${owner}/${repo}`,
      ]);
      if (closeResult.exitCode !== 0) {
        throw new Error(`Failed to close PR #${number}: ${closeResult.stderr}`);
      }
    }
  }

  async markPRReady(owner: string, repo: string, number: number): Promise<void> {
    const result = await this.executeGh([
      'pr', 'ready', String(number),
      '-R', `${owner}/${repo}`,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to mark PR #${number} as ready: ${result.stderr}`);
    }
  }

  async getPRComments(owner: string, repo: string, number: number): Promise<Comment[]> {
    // Get review comments using API
    const result = await this.executeGh([
      'api',
      `/repos/${owner}/${repo}/pulls/${number}/comments`,
      '--jq', '.[] | {id: .id, body: .body, author: .user.login, author_association: .author_association, path: .path, line: .line, in_reply_to_id: .in_reply_to_id, created_at: .created_at, updated_at: .updated_at}',
    ]);

    if (result.exitCode !== 0) {
      // No comments is not an error
      return [];
    }

    const lines = result.stdout.trim().split('\n').filter(l => l);
    const comments: Comment[] = [];
    for (const line of lines) {
      const data = parseJSONSafe(line) as Record<string, unknown> | null;
      if (!data) continue;
      comments.push({
        id: data['id'] as number,
        body: data['body'] as string,
        author: data['author'] as string,
        authorAssociation: data['author_association'] as string | undefined,
        path: data['path'] as string | undefined,
        line: data['line'] as number | undefined,
        in_reply_to_id: data['in_reply_to_id'] as number | undefined,
        created_at: data['created_at'] as string,
        updated_at: data['updated_at'] as string,
      });
    }
    return comments;
  }

  async getPRReviewThreads(owner: string, repo: string, number: number): Promise<ReviewThread[]> {
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes {
              databaseId
              body
              path
              line
              createdAt
              updatedAt
              author { login }
              authorAssociation
              replyTo { databaseId }
              viewerDidAuthor
            }
          }
        }
      }
    }
  }
}`;

    const result = await this.executeGh([
      'api', 'graphql',
      '-f', `query=${query}`,
      '-F', `owner=${owner}`,
      '-F', `repo=${repo}`,
      '-F', `number=${number}`,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to fetch review threads for PR #${number}: ${result.stderr}`);
    }

    const parsed = parseJSONSafe(result.stdout) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{
                id: string;
                isResolved: boolean;
                comments?: {
                  nodes?: Array<{
                    databaseId: number;
                    body: string;
                    path: string | null;
                    line: number | null;
                    createdAt: string;
                    updatedAt: string;
                    author: { login: string } | null;
                    authorAssociation: string | null;
                    replyTo: { databaseId: number } | null;
                    viewerDidAuthor: boolean | null;
                  }>;
                };
              }>;
            };
          };
        };
      };
    } | null;

    const nodes = parsed?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (!nodes) return [];

    const threads: ReviewThread[] = [];
    for (const node of nodes) {
      const commentNodes = node.comments?.nodes;
      if (!commentNodes || commentNodes.length === 0) continue;
      const comments: Comment[] = commentNodes.map(c => {
        const comment: Comment = {
          id: c.databaseId,
          body: c.body,
          author: c.author?.login ?? '',
          created_at: c.createdAt,
          updated_at: c.updatedAt,
        };
        if (c.path !== null && c.path !== undefined) comment.path = c.path;
        if (c.line !== null && c.line !== undefined) comment.line = c.line;
        if (c.replyTo?.databaseId !== undefined && c.replyTo?.databaseId !== null) {
          comment.in_reply_to_id = c.replyTo.databaseId;
        }
        if (c.authorAssociation !== null && c.authorAssociation !== undefined) {
          comment.authorAssociation = c.authorAssociation;
        }
        if (c.viewerDidAuthor !== null && c.viewerDidAuthor !== undefined) {
          comment.viewerDidAuthor = c.viewerDidAuthor;
        }
        return comment;
      });
      threads.push({
        id: node.id,
        rootCommentId: comments[0]!.id,
        isResolved: node.isResolved,
        comments,
      });
    }
    return threads;
  }

  async listReviews(owner: string, repo: string, prNumber: number): Promise<Review[]> {
    const result = await this.executeGh([
      'api',
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
      '--paginate',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list reviews for PR #${prNumber}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Array<{
      id: number;
      user: { login: string } | null;
      body: string | null;
      state: string;
      submitted_at: string;
      author_association?: string;
    }> | null;

    if (!data) return [];

    const allowedStates: ReadonlySet<ReviewSubmissionState> = new Set([
      'APPROVED',
      'CHANGES_REQUESTED',
      'COMMENTED',
      'DISMISSED',
      'PENDING',
    ]);

    // #1047 Finding 7: skip individual reviews with unrecognized `state`
    // rather than throwing for the whole batch. A single future GitHub state
    // (or casing/shape drift) must not silently disable the entire
    // #1047 gate — a skip with a debug log preserves every OTHER review's
    // participation in the gate and keeps the operator informed.
    const reviews: Review[] = [];
    for (const r of data) {
      if (!allowedStates.has(r.state as ReviewSubmissionState)) {
        // eslint-disable-next-line no-console
        console.debug(
          `[gh-cli] Skipping review ${r.id} on PR #${prNumber} — unrecognized state "${r.state}"`,
        );
        continue;
      }
      const review: Review = {
        id: r.id,
        user: { login: r.user?.login ?? '' },
        body: r.body ?? '',
        state: r.state as ReviewSubmissionState,
        submittedAt: r.submitted_at,
      };
      if (typeof r.author_association === 'string' && r.author_association.length > 0) {
        review.authorAssociation = r.author_association;
      }
      reviews.push(review);
    }
    return reviews;
  }

  async createReview(
    owner: string,
    repo: string,
    prNumber: number,
    input: CreateReviewInput,
  ): Promise<Review> {
    // The reviews endpoint accepts a nested `comments[]` array of objects,
    // which `-f field=value` cannot express. The shared `executeCommand`
    // wrapper ignores stdin (both the launcher and direct-spawn paths use
    // `stdio: ['ignore', ...]`), so `--input -` is unavailable here. Write the
    // JSON body to a temp file and pass `--input <file>` — same wire result.
    const body = {
      event: input.event,
      body: input.body,
      comments: (input.comments ?? []).map(c => ({
        path: c.path,
        line: c.line,
        side: c.side ?? 'RIGHT',
        body: c.body,
      })),
    };
    const inputPath = join(tmpdir(), `generacy-review-${randomUUID()}.json`);
    await writeFile(inputPath, JSON.stringify(body), 'utf8');
    let result;
    try {
      result = await this.executeGh([
        'api',
        '--method', 'POST',
        `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
        '--input', inputPath,
      ]);
    } finally {
      await unlink(inputPath).catch(() => {
        /* best-effort cleanup */
      });
    }

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create review on PR #${prNumber}: ${result.stderr}`,
      );
    }

    const data = parseJSONSafe(result.stdout) as {
      id: number;
      user: { login: string } | null;
      body: string | null;
      state: string;
      submitted_at: string;
      author_association?: string;
    } | null;

    if (!data) {
      throw new Error(
        `Failed to parse created review response on PR #${prNumber}`,
      );
    }

    const review: Review = {
      id: data.id,
      user: { login: data.user?.login ?? '' },
      body: data.body ?? '',
      state: data.state as ReviewSubmissionState,
      submittedAt: data.submitted_at,
    };
    if (typeof data.author_association === 'string' && data.author_association.length > 0) {
      review.authorAssociation = data.author_association;
    }
    return review;
  }

  async convertPullRequestToDraft(owner: string, repo: string, prNumber: number): Promise<void> {
    // Step 1 — resolve the PR node id + current draft state. If it is already
    // a draft, the conversion is a no-op (idempotent short-circuit).
    const query =
      'query($owner: String!, $repo: String!, $n: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $n) { id isDraft } } }';
    const queryResult = await this.executeGh([
      'api', 'graphql',
      '-f', `query=${query}`,
      '-F', `owner=${owner}`,
      '-F', `repo=${repo}`,
      '-F', `n=${prNumber}`,
    ]);
    if (queryResult.exitCode !== 0) {
      throw new Error(
        `convertPullRequestToDraft failed to resolve PR #${prNumber}: ${queryResult.stderr}`,
      );
    }
    const queryParsed = parseJSONSafe(queryResult.stdout) as {
      data?: { repository?: { pullRequest?: { id?: string; isDraft?: boolean } } };
      errors?: Array<{ message?: string }>;
    } | null;
    if (queryParsed?.errors && queryParsed.errors.length > 0) {
      const messages = queryParsed.errors.map(e => e.message ?? 'unknown').join('; ');
      throw new Error(
        `convertPullRequestToDraft returned GraphQL errors resolving PR #${prNumber}: ${messages}`,
      );
    }
    const pr = queryParsed?.data?.repository?.pullRequest;
    if (!pr?.id) {
      throw new Error(
        `convertPullRequestToDraft could not resolve node id for PR #${prNumber}`,
      );
    }
    if (pr.isDraft === true) return;

    // Step 2 — run the mutation, mirroring `resolveReviewThread`'s retry/auth
    // handling: 3× backoff, rethrow GhAuthError, terminal on GraphQL errors[].
    const mutation =
      'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }';
    const backoffs = [1000, 2000, 4000];
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.executeGh([
          'api', 'graphql',
          '-f', `query=${mutation}`,
          '-F', `id=${pr.id}`,
        ]);
        if (result.exitCode !== 0) {
          lastError = new Error(
            `convertPullRequestToDraft mutation failed for PR #${prNumber}: ${result.stderr}`,
          );
        } else {
          const parsed = parseJSONSafe(result.stdout) as
            | { errors?: Array<{ message?: string }> }
            | null;
          if (parsed?.errors && parsed.errors.length > 0) {
            const messages = parsed.errors.map(e => e.message ?? 'unknown').join('; ');
            throw new Error(
              `convertPullRequestToDraft returned GraphQL errors for PR #${prNumber}: ${messages}`,
            );
          }
          return;
        }
      } catch (err) {
        if (err instanceof GhAuthError) throw err;
        if (
          err instanceof Error &&
          err.message.startsWith('convertPullRequestToDraft returned GraphQL errors')
        ) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      const backoff = backoffs[attempt];
      if (backoff !== undefined) {
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
    throw lastError ?? new Error(`convertPullRequestToDraft failed for PR #${prNumber}`);
  }

  async listPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFile[]> {
    const result = await this.executeGh([
      'api',
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
      '--paginate',
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to list files for PR #${prNumber}: ${result.stderr}`);
    }
    const data = parseJSONSafe(result.stdout) as Array<{
      filename: string;
      status: string;
      patch?: string;
    }> | null;
    if (!data) return [];
    return data.map(f => {
      const file: PullRequestFile = { filename: f.filename, status: f.status };
      if (typeof f.patch === 'string') file.patch = f.patch;
      return file;
    });
  }

  async replyToPRComment(owner: string, repo: string, number: number, commentId: number, body: string): Promise<Comment> {
    const result = await this.executeGh([
      'api',
      '-X', 'POST',
      `/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
      '-f', `body=${body}`,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to reply to comment ${commentId}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Record<string, unknown> | null;
    if (!data) {
      throw new Error('Failed to parse reply response');
    }

    return {
      id: data['id'] as number,
      body: data['body'] as string,
      author: (data['user'] as { login: string }).login,
      created_at: data['created_at'] as string,
      updated_at: data['updated_at'] as string,
    };
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    const mutation =
      'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }';
    const backoffs = [1000, 2000, 4000];
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.executeGh([
          'api', 'graphql',
          '-f', `query=${mutation}`,
          '-F', `id=${threadId}`,
        ]);
        if (result.exitCode !== 0) {
          lastError = new Error(
            `resolveReviewThread failed for ${threadId}: ${result.stderr}`,
          );
        } else {
          const parsed = parseJSONSafe(result.stdout) as
            | { errors?: Array<{ message?: string }> }
            | null;
          if (parsed?.errors && parsed.errors.length > 0) {
            const messages = parsed.errors
              .map(e => e.message ?? 'unknown')
              .join('; ');
            throw new Error(
              `resolveReviewThread returned GraphQL errors for ${threadId}: ${messages}`,
            );
          }
          return;
        }
      } catch (err) {
        if (err instanceof GhAuthError) throw err;
        if (
          err instanceof Error &&
          err.message.startsWith('resolveReviewThread returned GraphQL errors')
        ) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      const backoff = backoffs[attempt];
      if (backoff !== undefined) {
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
    throw lastError ?? new Error(`resolveReviewThread failed for ${threadId}`);
  }

  async listOpenPullRequests(owner: string, repo: string): Promise<PullRequest[]> {
    // #1043 Finding 3: the issue-branch resolver filters this full list down to
    // `<N>-*` head refs, so a low cap can hide the canonical PR for a
    // high-numbered issue in a busy repo. `gh pr list --limit` paginates
    // internally up to the limit; raise it well above any plausible open-PR count.
    const result = await this.executeGh([
      'pr', 'list',
      '-R', `${owner}/${repo}`,
      '--state', 'open',
      '--json', 'number,title,body,state,isDraft,headRefName,baseRefName,labels,createdAt,updatedAt',
      '--limit', '1000',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list open PRs for ${owner}/${repo}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Array<Record<string, unknown>> | null;
    if (!data) {
      return [];
    }

    return data.map(pr => ({
      number: pr['number'] as number,
      title: pr['title'] as string,
      body: pr['body'] as string ?? '',
      state: 'open' as const,
      draft: pr['isDraft'] as boolean ?? false,
      head: { ref: pr['headRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      base: { ref: pr['baseRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      labels: ((pr['labels'] as Array<{ name: string; color: string }>) ?? []).map(l => ({
        name: l.name,
        color: l.color,
      })),
      created_at: pr['createdAt'] as string,
      updated_at: pr['updatedAt'] as string,
    }));
  }

  async listPrCommentBodies(owner: string, repo: string, prNumber: number): Promise<string[]> {
    // #1047 Finding 1: bodies may contain internal newlines (Disposition-C
    // marker + enumeration rows straddle multiple lines). Splitting raw
    // `--jq '.comments[].body'` stdout on `\n` produced one element per LINE,
    // not per comment — the marker line ended up alone in the array and the
    // ack-parser saw zero enumeration rows. Fix: pull the JSON array of
    // comments directly and extract each `.body` in JS, preserving internal
    // newlines as-is.
    const result = await this.executeGh([
      'pr', 'view', String(prNumber),
      '--repo', `${owner}/${repo}`,
      '--json', 'comments',
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to list PR comments for ${owner}/${repo}#${prNumber}: ${result.stderr}`);
    }
    const data = parseJSONSafe(result.stdout) as { comments?: Array<{ body?: string }> } | null;
    if (!data || !Array.isArray(data.comments)) return [];
    return data.comments
      .map(c => (typeof c.body === 'string' ? c.body : ''))
      .filter(b => b.length > 0);
  }

  async postPrComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    const result = await this.executeGh([
      'pr', 'comment', String(prNumber),
      '--repo', `${owner}/${repo}`,
      '--body', body,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to post PR comment on ${owner}/${repo}#${prNumber}: ${result.stderr}`);
    }
  }

  async findPRForBranch(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
    const result = await this.executeGh([
      'pr', 'list',
      '-R', `${owner}/${repo}`,
      '--head', branch,
      '--json', 'number,title,body,state,isDraft,headRefName,baseRefName,labels,createdAt,updatedAt',
      '--limit', '1',
    ]);

    if (result.exitCode !== 0) {
      return null;
    }

    const data = parseJSONSafe(result.stdout) as Array<Record<string, unknown>> | null;
    if (!data || data.length === 0) {
      return null;
    }

    const pr = data[0]!;
    return {
      number: pr['number'] as number,
      title: pr['title'] as string,
      body: pr['body'] as string ?? '',
      state: (pr['state'] as string).toLowerCase() === 'merged' ? 'merged' : 'open',
      draft: pr['isDraft'] as boolean ?? false,
      head: { ref: pr['headRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      base: { ref: pr['baseRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      labels: ((pr['labels'] as Array<{ name: string; color: string }>) ?? []).map(l => ({
        name: l.name,
        color: l.color,
      })),
      created_at: pr['createdAt'] as string,
      updated_at: pr['updatedAt'] as string,
    };
  }

  async findPRForBranchAnyState(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
    // #1051 PR #1052 review Finding 7: raise the limit and prefer a merged PR
    // if multiple exist. `--limit 1` returns newest by `created_at DESC`; a
    // fixture with a MERGED PR older than a CLOSED PR on the same head branch
    // (verified live against `884-problem-refreshaccesstoken`) would drop the
    // MERGED and report `reason: 'pr-closed'` at the guard's less-diagnostic
    // row. Merged-precedence is the intent (see push-guard.ts row 1); raise
    // to a small ceiling (10) so we can pick a merged PR when both exist.
    const result = await this.executeGh([
      'pr', 'list',
      '-R', `${owner}/${repo}`,
      '--head', branch,
      '--state', 'all',
      '--json', 'number,title,body,state,isDraft,headRefName,baseRefName,labels,createdAt,updatedAt',
      '--limit', '10',
    ]);

    // #1051 PR #1052 review Finding 4: throw on non-zero exit rather than
    // silently returning null. `findPRForBranch` (open-only) also returns
    // null on non-zero exit, but that method's callers do not rely on the
    // absence of a PR to decide safety — they can fall through to
    // `createPullRequest` which surfaces its own error. `push-guard.ts` DOES
    // rely on the distinction: a rate-limited `gh` call collapsed to `null`
    // reclassifies as "no PR ever" → the guard silently allows the exact
    // resurrection push it exists to block. Throwing lets the guard treat
    // the two cases differently (see guard's try/catch split).
    if (result.exitCode !== 0) {
      throw new Error(
        `findPRForBranchAnyState: gh pr list exited ${result.exitCode} for ${owner}/${repo} head=${branch}: ${result.stderr}`,
      );
    }

    const data = parseJSONSafe(result.stdout) as Array<Record<string, unknown>> | null;
    if (!data || data.length === 0) {
      return null;
    }

    const mapRow = (pr: Record<string, unknown>): PullRequest => {
      const stateRaw = String(pr['state'] ?? '').toLowerCase();
      const state: 'open' | 'closed' | 'merged' =
        stateRaw === 'merged' ? 'merged' : stateRaw === 'closed' ? 'closed' : 'open';
      return {
        number: pr['number'] as number,
        title: pr['title'] as string,
        body: pr['body'] as string ?? '',
        state,
        draft: pr['isDraft'] as boolean ?? false,
        head: { ref: pr['headRefName'] as string, sha: '', repo: `${owner}/${repo}` },
        base: { ref: pr['baseRefName'] as string, sha: '', repo: `${owner}/${repo}` },
        labels: ((pr['labels'] as Array<{ name: string; color: string }>) ?? []).map(l => ({
          name: l.name,
          color: l.color,
        })),
        created_at: pr['createdAt'] as string,
        updated_at: pr['updatedAt'] as string,
      };
    };

    // Merged-precedence: if any row is merged, return that one (most
    // diagnostic reason at the guard). Otherwise return the newest row
    // (`gh pr list` sorts by `created_at DESC` by default).
    const merged = data.find((row) => String(row['state'] ?? '').toLowerCase() === 'merged');
    return mapRow(merged ?? data[0]!);
  }

  // ==========================================================================
  // Label Operations
  // ==========================================================================

  async addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;

    const args = ['issue', 'edit', String(number), '-R', `${owner}/${repo}`];
    for (const label of labels) {
      args.push('--add-label', label);
    }

    const result = await this.executeGh(args);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to add labels: ${result.stderr}`);
    }
  }

  async removeLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;

    const args = ['issue', 'edit', String(number), '-R', `${owner}/${repo}`];
    for (const label of labels) {
      args.push('--remove-label', label);
    }

    const result = await this.executeGh(args);
    if (result.exitCode !== 0) {
      // Label might not exist, don't fail
      if (!result.stderr.includes('not found')) {
        throw new Error(`Failed to remove labels: ${result.stderr}`);
      }
    }
  }

  async getRepoLabels(owner: string, repo: string): Promise<Label[]> {
    const result = await this.executeGh([
      'label', 'list',
      '-R', `${owner}/${repo}`,
      '--json', 'name,color,description',
      '--limit', '1000',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get labels: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Array<{
      name: string;
      color: string;
      description?: string;
    }> | null;

    return data ?? [];
  }

  async createOrUpdateLabel(owner: string, repo: string, label: LabelDefinition): Promise<{ created: boolean }> {
    // Check if label exists
    const existing = await this.getRepoLabels(owner, repo);
    const exists = existing.some(l => l.name === label.name);

    if (exists) {
      // Update
      const args = [
        'label', 'edit', label.name,
        '-R', `${owner}/${repo}`,
        '--color', label.color.replace('#', ''),
      ];
      if (label.description) {
        args.push('--description', label.description);
      }

      const result = await this.executeGh(args);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to update label ${label.name}: ${result.stderr}`);
      }
      return { created: false };
    } else {
      // Create
      const args = [
        'label', 'create', label.name,
        '-R', `${owner}/${repo}`,
        '--color', label.color.replace('#', ''),
      ];
      if (label.description) {
        args.push('--description', label.description);
      }

      const result = await this.executeGh(args);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to create label ${label.name}: ${result.stderr}`);
      }
      return { created: true };
    }
  }

  // ==========================================================================
  // Git Operations (Local)
  // ==========================================================================

  async getStatus(): Promise<GitStatus> {
    const branchResult = await executeCommand('git', ['branch', '--show-current'], { cwd: this.workdir });
    const branch = branchResult.stdout.trim();

    const statusResult = await executeCommand('git', ['status', '--porcelain'], { cwd: this.workdir });
    const lines = statusResult.stdout.split('\n').filter(l => l);

    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      const indexStatus = line[0];
      const workingStatus = line[1];
      const file = line.substring(3);

      if (indexStatus === '?' && workingStatus === '?') {
        untracked.push(file);
      } else {
        if (indexStatus && indexStatus !== ' ' && indexStatus !== '?') {
          staged.push(file);
        }
        if (workingStatus && workingStatus !== ' ' && workingStatus !== '?') {
          unstaged.push(file);
        }
      }
    }

    // Detect unpushed commits
    let hasUnpushed = false;
    let unpushedCount = 0;
    if (branch) {
      try {
        const revListResult = await executeCommand(
          'git', ['rev-list', '--count', `origin/${branch}..HEAD`],
          { cwd: this.workdir }
        );
        if (revListResult.exitCode === 0) {
          const count = parseInt(revListResult.stdout.trim(), 10);
          if (count > 0) {
            hasUnpushed = true;
            unpushedCount = count;
          }
        }
      } catch {
        // No remote tracking branch or other error — treat as 0 unpushed
      }
    }

    return {
      branch,
      has_changes: lines.length > 0,
      staged,
      unstaged,
      untracked,
      hasUnpushed,
      unpushedCount,
    };
  }

  async getCurrentBranch(): Promise<string> {
    const result = await executeCommand('git', ['branch', '--show-current'], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to get current branch: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  async branchExists(branch: string, remote = false): Promise<boolean> {
    if (remote) {
      const result = await executeCommand('git', ['ls-remote', '--heads', 'origin', branch], { cwd: this.workdir });
      return result.stdout.includes(branch);
    } else {
      const result = await executeCommand('git', ['branch', '--list', branch], { cwd: this.workdir });
      return result.stdout.trim().length > 0;
    }
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    const args = ['checkout', '-b', name];
    if (startPoint) {
      args.push(startPoint);
    }

    const result = await executeCommand('git', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create branch ${name}: ${result.stderr}`);
    }
  }

  async checkout(branch: string): Promise<void> {
    const result = await executeCommand('git', ['checkout', branch], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to checkout ${branch}: ${result.stderr}`);
    }
  }

  async stageFiles(files: string[]): Promise<void> {
    if (files.length === 0) return;

    const result = await executeCommand('git', ['add', ...files], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to stage files: ${result.stderr}`);
    }
  }

  async stageAll(): Promise<void> {
    const result = await executeCommand('git', ['add', '-A'], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to stage all: ${result.stderr}`);
    }
  }

  async commit(message: string): Promise<CommitResult> {
    const result = await executeCommand('git', ['commit', '-m', message], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to commit: ${result.stderr}`);
    }

    // Get the commit SHA
    const shaResult = await executeCommand('git', ['rev-parse', 'HEAD'], { cwd: this.workdir });
    const sha = shaResult.stdout.trim();

    // Get committed files
    const diffResult = await executeCommand('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: this.workdir });
    const files = diffResult.stdout.split('\n').filter(f => f);

    return {
      sha,
      files_committed: files,
    };
  }

  async push(remote = 'origin', branch?: string, setUpstream = false): Promise<PushResult> {
    const currentBranch = branch ?? await this.getCurrentBranch();
    const args = ['push', remote, currentBranch];

    if (setUpstream) {
      args.splice(1, 0, '-u');
    }

    const result = await executeCommand('git', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to push: ${result.stderr}`);
    }

    return {
      success: true,
      ref: currentBranch,
      remote,
    };
  }

  async fetch(remote = 'origin', prune = true): Promise<void> {
    const args = ['fetch', remote];
    if (prune) {
      args.push('--prune');
    }

    const result = await executeCommand('git', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to fetch: ${result.stderr}`);
    }
  }

  async merge(branch: string, noCommit = false): Promise<MergeResult> {
    const args = ['merge', branch];
    if (noCommit) {
      args.push('--no-commit');
    }

    const result = await executeCommand('git', args, { cwd: this.workdir });

    // Check for conflicts
    if (result.exitCode !== 0 && result.stdout.includes('CONFLICT')) {
      const conflicted = await this.getConflictedFiles();
      const conflicts: ConflictInfo[] = conflicted.map(path => ({
        path,
        ours: '',
        theirs: '',
        resolved: false,
      }));

      return {
        success: false,
        commits_merged: 0,
        already_up_to_date: false,
        conflicts,
        summary: `Merge conflict in ${conflicts.length} file(s)`,
      };
    }

    if (result.exitCode !== 0) {
      throw new Error(`Failed to merge ${branch}: ${result.stderr}`);
    }

    // Check if already up to date
    if (result.stdout.includes('Already up to date')) {
      return {
        success: true,
        commits_merged: 0,
        already_up_to_date: true,
        conflicts: [],
        summary: 'Already up to date',
      };
    }

    // Count commits merged (rough estimate from output)
    const commitMatch = result.stdout.match(/(\d+) files? changed/);
    const filesChanged = commitMatch ? parseInt(commitMatch[1]!, 10) : 0;

    return {
      success: true,
      commits_merged: filesChanged > 0 ? 1 : 0,
      already_up_to_date: false,
      conflicts: [],
      summary: result.stdout.trim().split('\n')[0] ?? 'Merge completed',
    };
  }

  async mergeAbort(): Promise<void> {
    const result = await executeCommand('git', ['merge', '--abort'], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to abort merge: ${result.stderr}`);
    }
  }

  async stash(message?: string): Promise<boolean> {
    const args = ['stash', 'push'];
    if (message) {
      args.push('-m', message);
    }

    const result = await executeCommand('git', args, { cwd: this.workdir });
    // Returns true if something was stashed
    return !result.stdout.includes('No local changes to save');
  }

  async stashPop(): Promise<{ success: boolean; conflicts: boolean }> {
    const result = await executeCommand('git', ['stash', 'pop'], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      if (result.stderr.includes('CONFLICT')) {
        return { success: false, conflicts: true };
      }
      throw new Error(`Failed to pop stash: ${result.stderr}`);
    }

    return { success: true, conflicts: false };
  }

  async discardWorkingTreeChanges(excludePaths: string[] = []): Promise<void> {
    // Revert tracked modifications (staged + unstaged) to HEAD.
    const reset = await executeCommand('git', ['reset', '--hard', 'HEAD'], { cwd: this.workdir });
    if (reset.exitCode !== 0) {
      throw new Error(`Failed to reset working tree: ${reset.stderr}`);
    }

    // Remove untracked files/directories left behind by the abandoned work.
    // `-e <pattern>` keeps caller-owned untracked state (e.g. `.generacy/`).
    const cleanArgs = ['clean', '-fd'];
    for (const pattern of excludePaths) {
      cleanArgs.push('-e', pattern);
    }
    const clean = await executeCommand('git', cleanArgs, { cwd: this.workdir });
    if (clean.exitCode !== 0) {
      throw new Error(`Failed to clean working tree: ${clean.stderr}`);
    }
  }

  async getConflictedFiles(): Promise<string[]> {
    const result = await executeCommand('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: this.workdir });
    return result.stdout.split('\n').filter(f => f);
  }

  async getDefaultBranch(): Promise<string> {
    // Try to get from remote
    const result = await executeCommand('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: this.workdir });
    if (result.exitCode === 0) {
      return result.stdout.trim().replace('refs/remotes/origin/', '');
    }

    // Fallback to checking common names
    for (const branch of ['develop', 'main', 'master']) {
      const exists = await this.branchExists(branch, true);
      if (exists) return branch;
    }

    return 'main';
  }

  async getCommitsBetween(base: string, head: string): Promise<{ sha: string; message: string }[]> {
    const result = await executeCommand('git', [
      'log', `${base}..${head}`,
      '--format=%H|%s',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout.split('\n').filter(l => l).map(line => {
      const [sha, ...messageParts] = line.split('|');
      return {
        sha: sha ?? '',
        message: messageParts.join('|'),
      };
    });
  }

  async getFilesChangedBetween(base: string, head: string): Promise<string[]> {
    const result = await executeCommand('git', [
      'diff', '--name-only', `${base}...${head}`,
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(
        `git diff --name-only ${base}...${head} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }

    return result.stdout.split('\n').filter(Boolean);
  }

  async getCurrentCommitSha(): Promise<string> {
    const result = await executeCommand('git', [
      'rev-parse', 'HEAD',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(
        `git rev-parse HEAD failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }

    return result.stdout.trim();
  }

  async getFilesChangedByOwnCommits(startRef: string): Promise<string[]> {
    const result = await executeCommand('git', [
      'log', '--first-parent', '--no-merges', '--name-only', '--pretty=format:',
      `${startRef}..HEAD`,
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(
        `git log --first-parent --no-merges --name-only ${startRef}..HEAD failed ` +
          `(exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }

    const seen = new Set<string>();
    for (const line of result.stdout.split('\n')) {
      const path = line.trim();
      if (path) {
        seen.add(path);
      }
    }
    return [...seen];
  }

  async commitExistsInCheckout(sha: string): Promise<boolean> {
    const result = await executeCommand('git', [
      'rev-parse', '--verify', '--quiet', `${sha}^{commit}`,
    ], { cwd: this.workdir });

    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false; // commit-missing (FR-003, Q4=B)
    throw new Error(
      `git rev-parse --verify --quiet ${sha}^{commit} failed ` +
        `(exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }

  // ==========================================================================
  // Alias Methods (convenience wrappers)
  // ==========================================================================

  /**
   * Fetch the head commit SHA for a branch/ref (#892).
   * Uses `gh api repos/{o}/{r}/commits/{ref} --jq .sha` and validates that the
   * response is a 40-char lower-case hex SHA. Non-conforming output → throw.
   * 401 → `GhAuthError` via `executeGh` (existing #762 path).
   */
  async getRefHeadSha(owner: string, repo: string, ref: string): Promise<string> {
    const result = await this.executeGh([
      'api',
      `repos/${owner}/${repo}/commits/${ref}`,
      '--jq', '.sha',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(
        `getRefHeadSha ${owner}/${repo}@${ref} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }

    const sha = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(
        `Invalid SHA for ${owner}/${repo}@${ref}: ${sha.slice(0, 80)}`,
      );
    }
    return sha;
  }

  /**
   * Read CI runs for a commit SHA for merge-readiness aggregation (#1133).
   *
   * Primary: `gh api repos/{o}/{r}/commits/{sha}/check-runs` → source
   * `check-runs`. On non-zero exit — including the `GhAuthError` (HTTP 401/403)
   * that `executeGh` raises, which is the observed symptom of a token lacking
   * `checks:read` (FR-002) — fall back to
   * `gh api repos/{o}/{r}/actions/runs?branch={branch}` filtered client-side to
   * the head SHA → source `actions-runs`.
   *
   * Both paths are paginated (`--paginate` + `per_page=100`): the check-runs
   * endpoint caps at 30 results per page by default (same trap #1043 fixed for
   * `listBranches`). Without pagination a head SHA with >30 checks would expose
   * only page 1 to `aggregateCiVerdict`, so a failing or still-pending run past
   * page 1 would be invisible and could yield a false `green` — the exact
   * skipped≠passed safety hole this feature closes.
   *
   * Both paths normalize to `CiRun[]` consumable by `aggregateCiVerdict`
   * unchanged (SC-004). Empty result → `{ runs: [], source }`. Non-zero exit on
   * BOTH paths → throw with stderr (mirrors `getRefHeadSha`).
   */
  async getCiRunsForSha(
    owner: string,
    repo: string,
    headSha: string,
    branch: string,
  ): Promise<{ runs: CiRun[]; source: 'check-runs' | 'actions-runs' }> {
    let primaryError = '';
    try {
      const primary = await this.executeGh([
        'api',
        '--paginate',
        `repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
        '--jq', '.check_runs[] | {status, conclusion}',
      ]);
      if (primary.exitCode === 0) {
        return {
          runs: this.parseCiRunLines(primary.stdout),
          source: 'check-runs',
        };
      }
      primaryError = `exit ${primary.exitCode}: ${primary.stderr.trim()}`;
    } catch (err) {
      // executeGh throws GhAuthError on 401/403 — the checks:read-missing
      // symptom. Treat it as a fallback trigger, not a fatal readout error.
      primaryError = err instanceof Error ? err.message : String(err);
    }

    // #1157 FR-007: this fallback only enumerates GitHub-Actions `workflow_runs`
    // for the branch (filtered client-side to the head SHA). It is BLIND to
    // third-party required checks (external status contexts), so a `green`
    // aggregated from these runs may be a false green. The primary path is used
    // only when `check-runs` failed — the canonical symptom of a token lacking
    // `checks:read`. To close the false-green hole, `evaluateCiReadiness`
    // (packages/orchestrator/src/worker/ci-merge-readiness.ts) fails-closed:
    // when `source === 'actions-runs'` a would-be `green` is downgraded to
    // `not-passed`. Operator note: a `checks:read`-lacking cluster fails closed
    // (CI merge readiness never reports green via this fallback); granting the
    // token `checks:read` restores full third-party-check visibility via the
    // primary `check-runs` path.
    const fallback = await this.executeGh([
      'api',
      '--paginate',
      `repos/${owner}/${repo}/actions/runs?branch=${branch}&per_page=100`,
      '--jq', '.workflow_runs[] | {head_sha, status, conclusion}',
    ]);

    if (fallback.exitCode !== 0) {
      throw new Error(
        `getCiRunsForSha ${owner}/${repo}@${headSha} failed on both paths ` +
          `(check-runs ${primaryError}; ` +
          `actions-runs exit ${fallback.exitCode}: ${fallback.stderr.trim()})`,
      );
    }

    // The actions/runs jq keeps head_sha, so filter to the target SHA.
    const filtered: CiRun[] = [];
    for (const line of fallback.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseJSONSafe(trimmed) as
        | { head_sha?: unknown; status?: unknown; conclusion?: unknown }
        | null;
      if (!parsed || parsed.head_sha !== headSha) continue;
      filtered.push({
        status: typeof parsed.status === 'string' ? parsed.status : '',
        conclusion: (parsed.conclusion ?? null) as CiConclusion,
      });
    }

    return { runs: filtered, source: 'actions-runs' };
  }

  /**
   * Parse newline-delimited `{status, conclusion}` JSON objects (jq stream
   * output) into `CiRun[]`. Blank lines and unparseable lines are skipped.
   * Unknown `conclusion` values are passed through as-is.
   */
  private parseCiRunLines(stdout: string): CiRun[] {
    const runs: CiRun[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseJSONSafe(trimmed) as
        | { status?: unknown; conclusion?: unknown }
        | null;
      if (!parsed) continue;
      runs.push({
        status: typeof parsed.status === 'string' ? parsed.status : '',
        conclusion: (parsed.conclusion ?? null) as CiConclusion,
      });
    }
    return runs;
  }

  /**
   * List file names touched by a PR (`gh pr diff --name-only`, #892).
   * Non-zero exit → throw with stderr for visibility.
   */
  async prDiffNames(ownerRepo: string, prNumber: number): Promise<string[]> {
    const result = await this.executeGh([
      'pr', 'diff', String(prNumber),
      '--repo', ownerRepo,
      '--name-only',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(
        `prDiffNames ${ownerRepo}#${prNumber} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }

    return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    // List remote branches using gh api. #1043 Finding 3: paginate — the
    // /branches endpoint caps at 30 results per page by default, so without
    // `--paginate` + per_page=100 any `<N>-*` branch past page 1 is silently
    // dropped and the issue-branch resolver returns null → duplicate branch.
    const result = await this.executeGh([
      'api',
      '--paginate',
      `/repos/${owner}/${repo}/branches?per_page=100`,
      '--jq', '.[].name',
    ]);

    if (result.exitCode !== 0) {
      // Fallback to git
      const gitResult = await executeCommand('git', [
        'branch', '-r', '--format=%(refname:short)',
      ], { cwd: this.workdir });
      return gitResult.stdout.split('\n')
        .filter(b => b)
        .map(b => b.replace('origin/', ''));
    }

    return result.stdout.split('\n').filter(b => b);
  }

  async createPR(owner: string, repo: string, data: PRCreate): Promise<PullRequest> {
    return this.createPullRequest(owner, repo, data);
  }

  async updatePR(owner: string, repo: string, number: number, data: PRUpdate): Promise<void> {
    return this.updatePullRequest(owner, repo, number, data);
  }

  async getPRForBranch(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
    return this.findPRForBranch(owner, repo, branch);
  }

  async listLabels(owner: string, repo: string): Promise<Label[]> {
    return this.getRepoLabels(owner, repo);
  }

  async createLabel(owner: string, repo: string, name: string, color: string, description?: string): Promise<void> {
    const args = [
      'label', 'create', name,
      '-R', `${owner}/${repo}`,
      '--color', color.replace('#', ''),
    ];
    if (description) {
      args.push('--description', description);
    }

    const result = await this.executeGh(args);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create label ${name}: ${result.stderr}`);
    }
  }

  async updateLabel(owner: string, repo: string, name: string, data: { color?: string; description?: string }): Promise<void> {
    const args = ['label', 'edit', name, '-R', `${owner}/${repo}`];

    if (data.color) {
      args.push('--color', data.color.replace('#', ''));
    }
    if (data.description !== undefined) {
      args.push('--description', data.description);
    }

    const result = await this.executeGh(args);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to update label ${name}: ${result.stderr}`);
    }
  }
}
