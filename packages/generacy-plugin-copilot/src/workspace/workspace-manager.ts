/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Workspace lifecycle management.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { WorkspaceNotFoundError, WorkspaceInvalidStateError } from '../errors.js';
import { GitHubClient, parseIssueUrl } from '../github/client.js';
import type { GitHubPullRequest, GitHubReview } from '../github/types.js';
import { StatusPoller } from '../polling/status-poller.js';
import type { PollingConfig } from '../polling/types.js';
import type {
  FileChange,
  PullRequest,
  Workspace,
  WorkspaceOptions,
  WorkspaceStatus,
  WorkspaceStatusEvent,
} from '../types.js';
import type {
  CreateWorkspaceParams,
  InternalWorkspace,
  StatusInference,
  WorkspaceStore,
} from './types.js';

/**
 * In-memory workspace store.
 */
class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<string, InternalWorkspace>();

  get(workspaceId: string): InternalWorkspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  set(workspaceId: string, workspace: InternalWorkspace): void {
    this.workspaces.set(workspaceId, workspace);
  }

  delete(workspaceId: string): boolean {
    return this.workspaces.delete(workspaceId);
  }

  has(workspaceId: string): boolean {
    return this.workspaces.has(workspaceId);
  }

  keys(): Iterable<string> {
    return this.workspaces.keys();
  }

  clear(): void {
    this.workspaces.clear();
  }
}

/**
 * Workspace lifecycle manager.
 */
export class WorkspaceManager {
  private readonly store: WorkspaceStore;
  private readonly githubClient: GitHubClient;
  private readonly pollingConfig: Partial<PollingConfig>;
  private readonly defaultOptions: WorkspaceOptions;
  private readonly logger?: Logger;

  constructor(
    githubClient: GitHubClient,
    options: {
      store?: WorkspaceStore;
      pollingConfig?: Partial<PollingConfig>;
      defaultOptions?: WorkspaceOptions;
      logger?: Logger;
    } = {}
  ) {
    this.store = options.store ?? new InMemoryWorkspaceStore();
    this.githubClient = githubClient;
    this.pollingConfig = options.pollingConfig ?? {};
    this.defaultOptions = options.defaultOptions ?? {};
    this.logger = options.logger;
  }

  /**
   * Create a new workspace for tracking.
   */
  async createWorkspace(params: CreateWorkspaceParams): Promise<Workspace> {
    const parsed = parseIssueUrl(params.issueUrl);
    const workspaceId = this.generateWorkspaceId();
    const now = new Date();

    // Verify issue exists
    const issue = await this.githubClient.getIssue(
      parsed.owner,
      parsed.repo,
      parsed.issueNumber
    );

    const workspace: Workspace = {
      id: workspaceId,
      issueUrl: params.issueUrl,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      owner: parsed.owner,
      repo: parsed.repo,
      issueNumber: parsed.issueNumber,
    };

    const internal: InternalWorkspace = {
      workspace,
      pollState: {
        pollCount: 0,
        currentIntervalMs: 5000,
        startedAt: now,
        isActive: false,
      },
      github: {
        issueId: issue.id,
        linkedPRNumbers: [],
      },
      options: { ...this.defaultOptions, ...params.options },
    };

    this.store.set(workspaceId, internal);
    this.logger?.info({ workspaceId, issueUrl: params.issueUrl }, 'Workspace created');

    return workspace;
  }

  /**
   * Get a workspace by ID.
   */
  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    const internal = this.store.get(workspaceId);
    return internal?.workspace ?? null;
  }

  /**
   * Poll the current status of a workspace.
   */
  async pollWorkspaceStatus(workspaceId: string): Promise<WorkspaceStatus> {
    const internal = this.getInternalWorkspace(workspaceId);
    const inference = await this.inferStatusFromGitHub(internal);

    // Update workspace if status changed
    if (inference.status !== internal.workspace.status) {
      internal.workspace = {
        ...internal.workspace,
        status: inference.status,
        updatedAt: new Date(),
        pullRequestUrl: inference.prUrl ?? internal.workspace.pullRequestUrl,
      };
      internal.pollState.pollCount++;
      internal.pollState.lastPolledAt = new Date();

      if (inference.prNumber && !internal.github.linkedPRNumbers.includes(inference.prNumber)) {
        internal.github.linkedPRNumbers.push(inference.prNumber);
      }

      this.store.set(workspaceId, internal);
    }

    return inference.status;
  }

  /**
   * Get file changes from a completed workspace.
   */
  async getChanges(workspaceId: string): Promise<FileChange[]> {
    const internal = this.getInternalWorkspace(workspaceId);

    if (!['review_ready', 'merged'].includes(internal.workspace.status)) {
      throw new WorkspaceInvalidStateError(
        workspaceId,
        internal.workspace.status,
        ['review_ready', 'merged'],
        'get changes'
      );
    }

    const prNumber = internal.github.linkedPRNumbers[0];
    if (!prNumber) {
      return [];
    }

    const files = await this.githubClient.getPullRequestFiles(
      internal.workspace.owner,
      internal.workspace.repo,
      prNumber
    );

    return files.map((file) => ({
      path: file.filename,
      type: this.mapFileStatus(file.status),
      previousPath: file.previous_filename,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    }));
  }

  /**
   * Get the pull request associated with the workspace.
   */
  async getPullRequest(workspaceId: string): Promise<PullRequest | null> {
    const internal = this.getInternalWorkspace(workspaceId);
    const prNumber = internal.github.linkedPRNumbers[0];

    if (!prNumber) {
      return null;
    }

    const ghPr = await this.githubClient.getPullRequest(
      internal.workspace.owner,
      internal.workspace.repo,
      prNumber
    );

    const reviews = await this.githubClient.getPullRequestReviews(
      internal.workspace.owner,
      internal.workspace.repo,
      prNumber
    );

    return this.mapGitHubPRToPluginPR(ghPr, reviews, internal.workspace.issueNumber);
  }

  /**
   * Stream status updates from a workspace.
   */
  async *streamStatus(workspaceId: string): AsyncIterable<WorkspaceStatusEvent> {
    const internal = this.getInternalWorkspace(workspaceId);
    const poller = new StatusPoller(workspaceId, this.pollingConfig);

    const checkStatus = async () => {
      const inference = await this.inferStatusFromGitHub(internal);

      // Update internal state
      if (inference.status !== internal.workspace.status) {
        internal.workspace = {
          ...internal.workspace,
          status: inference.status,
          updatedAt: new Date(),
          pullRequestUrl: inference.prUrl ?? internal.workspace.pullRequestUrl,
        };
        this.store.set(workspaceId, internal);
      }

      return inference.status;
    };

    yield* poller.streamStatus(checkStatus);
  }

  /**
   * Delete a workspace.
   */
  deleteWorkspace(workspaceId: string): boolean {
    const deleted = this.store.delete(workspaceId);
    if (deleted) {
      this.logger?.info({ workspaceId }, 'Workspace deleted');
    }
    return deleted;
  }

  /**
   * Clear all workspaces.
   */
  clear(): void {
    this.store.clear();
    this.logger?.info('All workspaces cleared');
  }

  private getInternalWorkspace(workspaceId: string): InternalWorkspace {
    const internal = this.store.get(workspaceId);
    if (!internal) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return internal;
  }

  private async inferStatusFromGitHub(internal: InternalWorkspace): Promise<StatusInference> {
    try {
      // Check for linked PRs
      const prs = await this.githubClient.listLinkedPullRequests(
        internal.workspace.owner,
        internal.workspace.repo,
        internal.workspace.issueNumber
      );

      if (prs.length === 0) {
        // No PRs linked yet - still pending
        return { status: 'pending', confidence: 'medium' };
      }

      // Use the most recent PR
      const pr = prs[0]!;

      if (pr.merged) {
        return {
          status: 'merged',
          prNumber: pr.number,
          prUrl: pr.html_url,
          confidence: 'high',
        };
      }

      if (pr.state === 'closed') {
        return {
          status: 'failed',
          prNumber: pr.number,
          prUrl: pr.html_url,
          confidence: 'medium',
        };
      }

      // PR is open - check review status
      return {
        status: 'review_ready',
        prNumber: pr.number,
        prUrl: pr.html_url,
        confidence: 'high',
      };
    } catch (error) {
      this.logger?.warn({ workspaceId: internal.workspace.id, error }, 'Failed to infer status');
      return { status: 'not_available', confidence: 'low' };
    }
  }

  private mapFileStatus(
    status: string
  ): 'added' | 'modified' | 'deleted' | 'renamed' {
    switch (status) {
      case 'added':
        return 'added';
      case 'removed':
        return 'deleted';
      case 'renamed':
        return 'renamed';
      default:
        return 'modified';
    }
  }

  private mapGitHubPRToPluginPR(
    ghPr: GitHubPullRequest,
    reviews: GitHubReview[],
    issueNumber: number
  ): PullRequest {
    return {
      number: ghPr.number,
      url: ghPr.html_url,
      title: ghPr.title,
      body: ghPr.body ?? '',
      state: ghPr.merged ? 'merged' : ghPr.state,
      head: ghPr.head.ref,
      base: ghPr.base.ref,
      mergeable: ghPr.mergeable ?? undefined,
      linkedIssues: [issueNumber],
      reviewStatus: this.getReviewStatus(reviews),
      changedFiles: ghPr.changed_files,
      additions: ghPr.additions,
      deletions: ghPr.deletions,
    };
  }

  private getReviewStatus(
    reviews: GitHubReview[]
  ): 'pending' | 'approved' | 'changes_requested' | 'dismissed' {
    if (reviews.length === 0) {
      return 'pending';
    }

    // Get the most recent review state per reviewer
    const latestByReviewer = new Map<string, GitHubReview>();
    for (const review of reviews) {
      const existing = latestByReviewer.get(review.user.login);
      if (!existing || new Date(review.submitted_at) > new Date(existing.submitted_at)) {
        latestByReviewer.set(review.user.login, review);
      }
    }

    const states = [...latestByReviewer.values()].map((r) => r.state);

    if (states.includes('CHANGES_REQUESTED')) {
      return 'changes_requested';
    }
    if (states.includes('APPROVED')) {
      return 'approved';
    }
    if (states.includes('DISMISSED')) {
      return 'dismissed';
    }
    return 'pending';
  }

  private generateWorkspaceId(): string {
    return `ws_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
}
