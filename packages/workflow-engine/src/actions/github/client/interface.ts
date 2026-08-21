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
  Review,
  ReviewThread,
  CreateReviewInput,
  PullRequestFile,
  CiRun,
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
   * List submitted reviews on a PR via
   * `GET /repos/{owner}/{repo}/pulls/{number}/reviews`.
   *
   * Fetches submissions only — inline review-thread comments are NOT
   * included; use `getPRReviewThreads` for those. Every state is returned;
   * `state` filtering (e.g. to `{CHANGES_REQUESTED, COMMENTED}`) is
   * caller-side. Paginated internally when the response exceeds per-page
   * limits.
   *
   * Consumed by the PR-feedback body-consumption path (#1047).
   *
   * @throws GhAuthError on HTTP 401 or 403.
   * @throws Error on any other non-zero exit.
   */
  listReviews(owner: string, repo: string, prNumber: number): Promise<Review[]>;

  /**
   * Submit one PR review via
   * `POST /repos/{owner}/{repo}/pulls/{prNumber}/reviews`.
   *
   * One atomic submission carrying the `event`, a top-level `body`, and
   * optional inline `comments[]`. Every inline comment MUST anchor to a
   * diffable line — a non-diffable `line` 422s the entire submission
   * (the caller pre-checks diffability via `listPullRequestFiles`). No
   * internal retry for a 422 (it is a caller payload bug, not transient).
   *
   * @throws Error with the upstream stderr on non-zero exit.
   */
  createReview(
    owner: string,
    repo: string,
    prNumber: number,
    input: CreateReviewInput,
  ): Promise<Review>;

  /**
   * Convert a ready PR back to draft via the GraphQL
   * `convertPullRequestToDraft` mutation.
   *
   * Two steps: resolve the PR node id + `isDraft` (short-circuits when the
   * PR is already a draft), then run the mutation. Mirrors
   * `resolveReviewThread`'s retry/auth handling — 3× backoff, `GhAuthError`
   * rethrown, GraphQL `errors[]` terminal.
   *
   * @throws GhAuthError on HTTP 401 or 403.
   * @throws Error on terminal failure.
   */
  convertPullRequestToDraft(owner: string, repo: string, prNumber: number): Promise<void>;

  /**
   * List the files changed in a PR via
   * `GET /repos/{owner}/{repo}/pulls/{prNumber}/files` (paginated).
   *
   * Each entry carries `filename`, `status`, and an optional `patch`
   * (unified-diff hunks; absent for binary/too-large files). Used to
   * compute the set of diffable lines for inline review anchoring.
   *
   * @throws Error with the upstream stderr on non-zero exit.
   */
  listPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFile[]>;

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

  /**
   * Find a PR for a branch across all states (open, closed, merged).
   *
   * Mirrors `findPRForBranch` but passes `--state all` to `gh pr list`, so
   * callers can detect merged/closed PRs on a branch — used by the push-guard
   * (#1051 FR-002) to refuse pushes to branches whose PR has already merged.
   *
   * Do NOT use this in place of `findPRForBranch` at existing call sites:
   * five callers depend on the open-only default and a silent state widening
   * would create foot-guns. See #1051 clarification Q2.
   */
  findPRForBranchAnyState(owner: string, repo: string, branch: string): Promise<PullRequest | null>;

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
   * Commit changes.
   *
   * @param message Commit message.
   * @param pathspec Optional path list. When provided, only these paths are
   *   committed (`git commit -m <msg> -- <pathspec>`), bypassing any other
   *   content staged in the index — so a caller can guarantee an unrelated
   *   pre-staged path (e.g. an engine bookkeeping sidecar, #1162) is never
   *   folded into the commit. When omitted, the whole index is committed
   *   (unchanged legacy behavior).
   */
  commit(message: string, pathspec?: string[]): Promise<CommitResult>;

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
   * Discard all working-tree changes: hard-reset tracked files to HEAD and
   * remove untracked files/directories. Used to guarantee "branch untouched"
   * when abandoning a phase's partial work.
   *
   * @param excludePaths gitignore-style patterns forwarded to `git clean -e`
   *   so caller-owned state (e.g. orchestrator sidecars under `.generacy/`)
   *   survives the clean.
   */
  discardWorkingTreeChanges(excludePaths?: string[]): Promise<void>;

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
   * Current HEAD commit SHA of the checkout workdir (#1107).
   * Equivalent to `git rev-parse HEAD`, trimmed.
   *
   * @returns The 40-char commit SHA.
   * @throws Error when the git command exits non-zero.
   */
  getCurrentCommitSha(): Promise<string>;

  /**
   * Files touched by the branch's OWN commits since `startRef` (#1107).
   * Excludes merge commits and merged-in base-branch commits by using
   * first-parent traversal: `git log --first-parent --no-merges --name-only
   * --pretty=format: <startRef>..HEAD`.
   *
   * @param startRef The ref anchoring the window's lower bound.
   * @returns Unique, non-empty, trimmed repo-relative paths; empty when no own
   *   (non-merge, first-parent) commits exist since `startRef`.
   * @throws Error when the git command exits non-zero (unreachable ref, ...).
   */
  getFilesChangedByOwnCommits(startRef: string): Promise<string[]>;

  /**
   * Whether `sha` resolves to a commit object in the local checkout (#1112).
   * Runs `git rev-parse --verify --quiet <sha>^{commit}` in the workdir.
   *
   * @param sha A 7-40 hex commit ref (as accepted by isValidCommitSha).
   * @returns true when the commit exists (git exit 0); false when it is missing
   *   (git exit 1 — for both full and abbreviated shas).
   * @throws Error on any other git exit (e.g. 128 — corrupt/inaccessible git dir,
   *   not a repository) with the exit code and stderr, so an environment fault is
   *   never mistaken for a missing commit.
   */
  commitExistsInCheckout(sha: string): Promise<boolean>;

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
   * Read the CI runs for a commit SHA, for merge-readiness aggregation (#1133).
   *
   * Primary path queries the check-runs API; on non-zero exit (the observed
   * symptom of a token lacking `checks:read`) it falls back to the actions/runs
   * API filtered to the head SHA. Both paths normalize to `CiRun[]` consumable
   * by `aggregateCiVerdict` unchanged — the verdict for a given real CI state is
   * identical across paths (SC-004).
   *
   * @param owner - Repository owner.
   * @param repo - Repository name.
   * @param headSha - The commit SHA to read CI runs for.
   * @param branch - Branch name, used by the actions/runs fallback filter.
   * @returns The normalized runs and which source produced them. Empty result
   *   (no check-runs and no matching actions/runs) → `{ runs: [], source }`.
   * @throws Error with stderr when BOTH paths exit non-zero (mirrors
   *   `getRefHeadSha`). The caller's readiness wait treats a thrown readout as
   *   transient and continues backoff.
   */
  getCiRunsForSha(
    owner: string,
    repo: string,
    headSha: string,
    branch: string,
  ): Promise<{ runs: CiRun[]; source: 'check-runs' | 'actions-runs' }>;

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
