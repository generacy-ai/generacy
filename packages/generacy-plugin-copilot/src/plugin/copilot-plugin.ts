/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Main plugin class implementing CopilotPluginInterface.
 */

import pino, { type Logger } from 'pino';
import { CopilotPluginOptionsSchema } from '../schemas.js';
import { GitHubClient } from '../github/client.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import type {
  CopilotPluginInterface,
  CopilotPluginOptions,
  CreateWorkspaceParams,
  FileChange,
  PollingConfig,
  PullRequest,
  Workspace,
  WorkspaceStatus,
  WorkspaceStatusEvent,
} from '../types.js';

/**
 * GitHub Copilot Workspace plugin for Generacy.
 *
 * Note: Due to the lack of a public Copilot Workspace API, this plugin
 * operates in a tracking/monitoring mode, inferring workspace status
 * from GitHub Issues and Pull Requests.
 */
export class CopilotPlugin implements CopilotPluginInterface {
  private readonly githubClient: GitHubClient;
  private readonly workspaceManager: WorkspaceManager;
  private readonly logger: Logger;
  private readonly pollingConfig: Partial<PollingConfig>;
  private isDisposed = false;

  constructor(options: CopilotPluginOptions) {
    // Validate options
    const validated = CopilotPluginOptionsSchema.parse(options);

    // Initialize logger
    this.logger = (validated.logger as Logger | undefined) ?? pino({
      name: 'copilot-plugin',
      level: process.env['LOG_LEVEL'] ?? 'info',
    });

    // Initialize GitHub client
    this.githubClient = new GitHubClient({
      token: validated.githubToken,
      baseUrl: validated.apiBaseUrl,
    });

    // Store polling config
    this.pollingConfig = validated.polling ?? {};

    // Initialize workspace manager
    this.workspaceManager = new WorkspaceManager(this.githubClient, {
      pollingConfig: this.pollingConfig,
      defaultOptions: validated.workspaceDefaults,
      logger: this.logger,
    });

    this.logger.info('CopilotPlugin initialized');
  }

  /**
   * Create a new workspace for tracking.
   *
   * Note: This does not create an actual Copilot Workspace (no public API).
   * It sets up tracking for when a workspace is manually created via GitHub.
   */
  async createWorkspace(params: CreateWorkspaceParams): Promise<Workspace> {
    this.ensureNotDisposed();
    this.logger.debug({ issueUrl: params.issueUrl }, 'Creating workspace');

    const workspace = await this.workspaceManager.createWorkspace(params);

    this.logger.info(
      { workspaceId: workspace.id, issueUrl: params.issueUrl },
      'Workspace created for tracking'
    );

    return workspace;
  }

  /**
   * Get an existing workspace by ID.
   */
  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    this.ensureNotDisposed();
    return this.workspaceManager.getWorkspace(workspaceId);
  }

  /**
   * Poll the current status of a workspace.
   *
   * Status is inferred from GitHub PR state since there's no direct
   * Copilot Workspace API to query.
   */
  async pollWorkspaceStatus(workspaceId: string): Promise<WorkspaceStatus> {
    this.ensureNotDisposed();
    this.logger.debug({ workspaceId }, 'Polling workspace status');

    const status = await this.workspaceManager.pollWorkspaceStatus(workspaceId);

    this.logger.debug({ workspaceId, status }, 'Workspace status polled');
    return status;
  }

  /**
   * Get file changes from a completed workspace.
   *
   * Returns changes from the associated pull request.
   */
  async getChanges(workspaceId: string): Promise<FileChange[]> {
    this.ensureNotDisposed();
    this.logger.debug({ workspaceId }, 'Getting workspace changes');

    const changes = await this.workspaceManager.getChanges(workspaceId);

    this.logger.debug(
      { workspaceId, changeCount: changes.length },
      'Workspace changes retrieved'
    );
    return changes;
  }

  /**
   * Get the pull request associated with the workspace.
   */
  async getPullRequest(workspaceId: string): Promise<PullRequest | null> {
    this.ensureNotDisposed();
    this.logger.debug({ workspaceId }, 'Getting workspace pull request');

    const pr = await this.workspaceManager.getPullRequest(workspaceId);

    if (pr) {
      this.logger.debug({ workspaceId, prNumber: pr.number }, 'Pull request retrieved');
    } else {
      this.logger.debug({ workspaceId }, 'No pull request found');
    }

    return pr;
  }

  /**
   * Stream status updates from a workspace.
   *
   * Polls GitHub at configured intervals and yields events
   * when status changes are detected.
   */
  async *streamStatus(workspaceId: string): AsyncIterable<WorkspaceStatusEvent> {
    this.ensureNotDisposed();
    this.logger.debug({ workspaceId }, 'Starting status stream');

    let eventCount = 0;
    for await (const event of this.workspaceManager.streamStatus(workspaceId)) {
      eventCount++;
      this.logger.debug(
        {
          workspaceId,
          previousStatus: event.previousStatus,
          status: event.status,
        },
        'Status change detected'
      );
      yield event;
    }

    this.logger.debug({ workspaceId, eventCount }, 'Status stream completed');
  }

  /**
   * Dispose of the plugin and cleanup resources.
   */
  async dispose(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    this.logger.info('Disposing CopilotPlugin');
    this.workspaceManager.clear();
    this.isDisposed = true;
    this.logger.info('CopilotPlugin disposed');
  }

  private ensureNotDisposed(): void {
    if (this.isDisposed) {
      throw new Error('Plugin has been disposed');
    }
  }
}
