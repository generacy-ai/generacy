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
   * Update a comment
   */
  updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void>;

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
   * Get comments on a PR (review comments)
   */
  getPRComments(owner: string, repo: string, number: number): Promise<Comment[]>;

  /**
   * Reply to a PR comment
   */
  replyToPRComment(owner: string, repo: string, number: number, commentId: number, body: string): Promise<Comment>;

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
   * List all branches in the repository
   */
  listBranches(owner: string, repo: string): Promise<string[]>;

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
export type GitHubClientFactory = (workdir?: string) => GitHubClient;
