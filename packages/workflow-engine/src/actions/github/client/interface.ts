/**
 * GitHubClient interface - provider abstraction for GitHub operations.
 * Allows different implementations (gh CLI, Octokit, etc.) to be swapped.
 */
import type {
  Issue,
  PullRequest,
  Comment,
  Label,
  RepoInfo,
  ConflictInfo,
  ReviewThread,
} from '../../../types/github.js';

/**
 * Issue update data
 */
export interface IssueUpdate {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: string[];
  assignees?: string[];
}

/**
 * PR creation data
 */
export interface PRCreate {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}

/**
 * PR update data
 */
export interface PRUpdate {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
}

/**
 * Merge result from git merge operations
 */
export interface MergeResult {
  success: boolean;
  commits_merged: number;
  already_up_to_date: boolean;
  conflicts: ConflictInfo[];
  summary: string;
}

/**
 * Commit result
 */
export interface CommitResult {
  sha: string;
  files_committed: string[];
}

/**
 * Push result
 */
export interface PushResult {
  success: boolean;
  ref: string;
  remote: string;
}

/**
 * Git status result
 */
export interface GitStatus {
  branch: string;
  has_changes: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  /** True when local HEAD is ahead of origin/<branch> */
  hasUnpushed: boolean;
  /** Number of commits ahead of origin/<branch>. 0 if no remote tracking branch. */
  unpushedCount: number;
}

/**
 * Label definition for sync operations
 */
export interface LabelDefinition {
  name: string;
  color: string;
  description?: string;
}

/**
 * GitHubClient interface - abstraction for GitHub and Git operations.
 * Implementations can use gh CLI, Octokit, or other backends.
 */
export interface GitHubClient {
  // ==========================================================================
  // Repository Info
  // ==========================================================================

  /**
   * Get repository information
   */
  getRepoInfo(): Promise<RepoInfo>;

  // ==========================================================================
  // Issue Operations
  // ==========================================================================

  /**
   * Get an issue by number
   */
  getIssue(owner: string, repo: string, number: number): Promise<Issue>;

  /**
   * Update an issue
   */
  updateIssue(owner: string, repo: string, number: number, data: IssueUpdate): Promise<void>;

  /**
   * Add a comment to an issue
   */
  addIssueComment(owner: string, repo: string, number: number, body: string): Promise<Comment>;

  /**
   * Get comments on an issue
   */
  getIssueComments(owner: string, repo: string, number: number): Promise<Comment[]>;

  /**
   * Fetch issue comments via GraphQL with `viewerDidAuthor` populated per
   * comment. Sibling to `getIssueComments()` (REST) and mirror of
   * `getPRReviewThreads()` (existing GraphQL precedent from #878).
   *
   * Callers that pass results through `isTrustedCommentAuthor(c, surface, ctx)`
   * MUST use this method — REST does not surface `viewerDidAuthor`, so
   * App-identity clusters cannot self-recognize their own posts and the
   * trust helper rejects them at tier NONE. Consumed by
   * `integrateClarificationAnswers` (answer-scanner surface) and
   * `buildTrustedIssueCommentsBlock` (clarify-resume surface).
   *
   * Returns the first page (`first: 100`) only — matches
   * `getPRReviewThreads()` pagination posture. See #910.
   *
   * @throws GhAuthError on HTTP 401 or 403.
   * @throws Error on any other non-zero exit.
   */
  getIssueCommentsWithViewerAuth(owner: string, repo: string, number: number): Promise<Comment[]>;

  /**
   * Update a comment
   */
  updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void>;

  /**
   * Get the label names on an issue. Cheaper than `getIssue` when only labels
   * are needed (e.g., pre-enqueue `blocked:*` skip checks). See #883.
   */
  getIssueLabels(owner: string, repo: string, number: number): Promise<string[]>;

  /**
   * List open issues in a repository that have a specific label
   */
  listIssuesWithLabel(owner: string, repo: string, label: string): Promise<Issue[]>;

  // ==========================================================================
  // PR Operations
  // ==========================================================================

  /**
   * Create a pull request
   */
  createPullRequest(owner: string, repo: string, data: PRCreate): Promise<PullRequest>;

  /**
   * Get a pull request by number
   */
  getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest>;

  /**
   * Update a pull request
   */
  updatePullRequest(owner: string, repo: string, number: number, data: PRUpdate): Promise<void>;

  /**
   * Mark a draft PR as ready for review
   */
  markPRReady(owner: string, repo: string, number: number): Promise<void>;

  /**
   * Get comments on a PR (review comments).
   *
   * @deprecated The REST endpoint underneath this method does not expose
   * thread resolution — every returned `Comment.resolved` is `undefined`.
   * Use `getPRReviewThreads()` instead. Removed in a follow-up PR. See #861.
   */
  getPRComments(owner: string, repo: string, number: number): Promise<Comment[]>;

  /**
   * Fetch all review threads on a PR, with resolution state, via GraphQL.
   *
   * The REST endpoint at `/repos/{owner}/{repo}/pulls/{n}/comments` does NOT
   * expose thread resolution — thread state is a GraphQL-only concept.
   * Callers that need per-thread resolved state MUST use this method.
   * `getPRComments()` is deprecated; do not use it for new code.
   *
   * @throws GhAuthError on HTTP 401 or 403.
   * @throws Error on any other non-zero exit.
   */
  getPRReviewThreads(owner: string, repo: string, number: number): Promise<ReviewThread[]>;

  /**
   * Reply to a PR comment
   */
  replyToPRComment(owner: string, repo: string, number: number, commentId: number, body: string): Promise<Comment>;

  /**
   * Resolve a PR review thread via the GraphQL `resolveReviewThread` mutation.
   *
   * Retries transient failures up to 3 times with 1s / 2s / 4s backoff. Auth
   * failures (`GhAuthError`) are NOT retried — they are rethrown on the first
   * attempt (aligns with #762 convention). GraphQL-level `errors[]` on a 200
   * response are treated as terminal (deleted node, permission-denied) and are
   * NOT retried. On persistent transient failure, throws `Error` with the
   * last upstream stderr as the message. See #883.
   *
   * @param threadId - The GraphQL node ID of the thread (see ReviewThread.id).
   */
  resolveReviewThread(threadId: string): Promise<void>;

  /**
   * List all open pull requests in a repository
   */
  listOpenPullRequests(owner: string, repo: string): Promise<PullRequest[]>;

  /**
   * List top-level (issue-comment) PR comment bodies for idempotency
   * checks (#869 / FR-004). Does NOT return review-thread comment bodies
   * (those come from `getPRReviewThreads`).
   */
  listPrCommentBodies(owner: string, repo: string, prNumber: number): Promise<string[]>;

  /**
   * Post a top-level PR comment (issue-comment API, not review-thread reply).
   * Used by the PR-feedback monitor to post the untrusted-notice per FR-004.
   */
  postPrComment(owner: string, repo: string, prNumber: number, body: string): Promise<void>;

  /**
   * Find PR for the current branch
   */
  findPRForBranch(owner: string, repo: string, branch: string): Promise<PullRequest | null>;

  // ==========================================================================
  // Label Operations
  // ==========================================================================

  /**
   * Add labels to an issue/PR
   */
  addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void>;

  /**
   * Remove labels from an issue/PR
   */
  removeLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void>;

  /**
   * Get all labels in a repository
   */
  getRepoLabels(owner: string, repo: string): Promise<Label[]>;

  /**
   * Create or update a label
   */
  createOrUpdateLabel(owner: string, repo: string, label: LabelDefinition): Promise<{ created: boolean }>;

  // ==========================================================================
  // Git Operations (Local)
  // ==========================================================================

  /**
   * Get current git status
   */
  getStatus(): Promise<GitStatus>;

  /**
   * Get current branch name
   */
  getCurrentBranch(): Promise<string>;

  /**
   * Check if a branch exists
   */
  branchExists(branch: string, remote?: boolean): Promise<boolean>;

  /**
   * Create a new branch
   */
  createBranch(name: string, startPoint?: string): Promise<void>;

  /**
   * Checkout a branch
   */
  checkout(branch: string): Promise<void>;

  /**
   * Stage files for commit
   */
  stageFiles(files: string[]): Promise<void>;

  /**
   * Stage all changes
   */
  stageAll(): Promise<void>;

  /**
   * Commit staged changes
   */
  commit(message: string): Promise<CommitResult>;

  /**
   * Push to remote
   */
  push(remote?: string, branch?: string, setUpstream?: boolean): Promise<PushResult>;

  /**
   * Fetch from remote
   */
  fetch(remote?: string, prune?: boolean): Promise<void>;

  /**
   * Merge a branch
   */
  merge(branch: string, noCommit?: boolean): Promise<MergeResult>;

  /**
   * Abort a merge in progress
   */
  mergeAbort(): Promise<void>;

  /**
   * Stash changes
   */
  stash(message?: string): Promise<boolean>;

  /**
   * Pop stashed changes
   */
  stashPop(): Promise<{ success: boolean; conflicts: boolean }>;

  /**
   * Get list of files with merge conflicts
   */
  getConflictedFiles(): Promise<string[]>;

  /**
   * Get the default branch (main/master/develop)
   */
  getDefaultBranch(): Promise<string>;

  /**
   * Get commits between two refs
   */
  getCommitsBetween(base: string, head: string): Promise<{ sha: string; message: string }[]>;

  /**
   * List files changed between two refs using merge-base (triple-dot) semantics.
   * Equivalent to `git diff --name-only <base>...<head>`.
   *
   * @param base Base ref, typically `origin/<branch>`.
   * @param head Head ref, typically `HEAD`.
   * @returns Repo-relative file paths as emitted by git; empty array `[]` never null/undefined.
   * @throws Error when the git command exits non-zero (missing ref, no fetch, ...).
   */
  getFilesChangedBetween(base: string, head: string): Promise<string[]>;

  /**
   * List all branches in the repository
   */
  listBranches(owner: string, repo: string): Promise<string[]>;

  /**
   * Returns the current head commit SHA of a branch or ref.
   * Used by BaseAdvanceMonitorService to detect base-branch advances (#892).
   *
   * @param ref - Branch/ref name, e.g. "develop", "main", "release/v2".
   * @returns Full 40-character lower-case hex SHA.
   * @throws GhAuthError on HTTP 401 (feeds #762 auth-health backstop).
   * @throws Error on malformed response (non-40-hex).
   */
  getRefHeadSha(owner: string, repo: string, ref: string): Promise<string>;

  /**
   * List the file names touched by a pull request via `gh pr diff --name-only`.
   * Used by ValidateFixHandler's sibling-duplication guard (#892).
   *
   * @param ownerRepo - `owner/repo` slug (matches gh CLI's `--repo` flag shape).
   * @param prNumber - Pull request number.
   * @returns Repo-relative file paths; empty array if no changes.
   * @throws Error on non-zero exit.
   */
  prDiffNames(ownerRepo: string, prNumber: number): Promise<string[]>;

  /**
   * Create a PR (alias for createPullRequest)
   */
  createPR(owner: string, repo: string, data: PRCreate): Promise<PullRequest>;

  /**
   * Update a PR (alias for updatePullRequest)
   */
  updatePR(owner: string, repo: string, number: number, data: PRUpdate): Promise<void>;

  /**
   * Get PR for a branch (alias for findPRForBranch)
   */
  getPRForBranch(owner: string, repo: string, branch: string): Promise<PullRequest | null>;

  /**
   * List all labels in a repository (alias for getRepoLabels)
   */
  listLabels(owner: string, repo: string): Promise<Label[]>;

  /**
   * Create a label
   */
  createLabel(owner: string, repo: string, name: string, color: string, description?: string): Promise<void>;

  /**
   * Update a label
   */
  updateLabel(owner: string, repo: string, name: string, data: { color?: string; description?: string }): Promise<void>;
}

/**
 * Factory function type for creating GitHubClient instances
 */
export type GitHubClientFactory = (
  workdir?: string,
  tokenProvider?: () => Promise<string | undefined>,
) => GitHubClient;
