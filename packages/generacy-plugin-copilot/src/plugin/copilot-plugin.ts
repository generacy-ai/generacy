/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Main plugin class extending AbstractDevAgentPlugin and implementing CopilotPluginInterface.
 */

import pino, { type Logger } from 'pino';
import type {
  AgentResult,
  AgentCapabilities,
  StreamChunk,
} from '@generacy-ai/latency';
import { FacetError } from '@generacy-ai/latency';
import {
  AbstractDevAgentPlugin,
  type InternalInvokeOptions,
} from '@generacy-ai/latency-plugin-dev-agent';
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
 * Extends AbstractDevAgentPlugin to provide the standard DevAgent interface
 * while also exposing Copilot Workspace-specific functionality.
 *
 * Note: Due to the lack of a public Copilot Workspace API, this plugin
 * operates in a tracking/monitoring mode, inferring workspace status
 * from GitHub Issues and Pull Requests. The DevAgent interface methods
 * (`invoke`, `invokeStream`) create workspaces and monitor them to completion.
 */
export class CopilotPlugin extends AbstractDevAgentPlugin implements CopilotPluginInterface {
  private readonly githubClient: GitHubClient;
  private readonly workspaceManager: WorkspaceManager;
  private readonly logger: Logger;
  private readonly pollingConfig: Partial<PollingConfig>;
  private isDisposed = false;

  constructor(options: CopilotPluginOptions) {
    super({ defaultTimeoutMs: options.defaultTimeoutMs ?? 300_000 }); // 5 minute default for workspace operations

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

  // ==========================================================================
  // AbstractDevAgentPlugin abstract method implementations
  // ==========================================================================

  /**
   * Invoke Copilot Workspace with a prompt (implements abstract method).
   *
   * Creates a workspace for the given prompt and waits for completion.
   * Since there's no public API for Copilot Workspace, this monitors
   * the workspace status via GitHub until completion or timeout.
   */
  protected async doInvoke(
    prompt: string,
    options: InternalInvokeOptions,
  ): Promise<AgentResult> {
    this.ensureNotDisposed();

    // Extract issue URL from prompt or metadata
    const issueUrl = this.extractIssueUrl(prompt, options.metadata);
    if (!issueUrl) {
      throw new FacetError(
        'Prompt must contain or metadata must include an issueUrl for Copilot Workspace',
        'VALIDATION',
      );
    }

    this.logger.debug({ issueUrl, invocationId: options.invocationId }, 'Starting Copilot invocation');

    // Create workspace for tracking
    const workspace = await this.workspaceManager.createWorkspace({
      issueUrl,
    });

    // Collect output as we monitor the workspace
    const output: string[] = [];
    let finalStatus: WorkspaceStatus = 'pending';

    try {
      // Stream status updates until completion (terminal states: merged, failed, not_available)
      for await (const event of this.workspaceManager.streamStatus(workspace.id)) {
        if (options.signal.aborted) {
          throw new FacetError('Invocation was cancelled', 'CANCELLED');
        }

        output.push(`Status: ${event.previousStatus} → ${event.status}`);
        finalStatus = event.status;

        if (finalStatus === 'merged' || finalStatus === 'failed' || finalStatus === 'not_available') {
          break;
        }
      }

      // Get final changes if merged
      if (finalStatus === 'merged') {
        const changes = await this.workspaceManager.getChanges(workspace.id);
        output.push(`\nCompleted with ${changes.length} file changes:`);
        for (const change of changes) {
          output.push(`  - ${change.path} (${change.type})`);
        }
      }

      return {
        output: output.join('\n'),
        invocationId: options.invocationId,
      };
    } catch (error) {
      if (error instanceof FacetError) {
        throw error;
      }
      throw new FacetError(
        error instanceof Error ? error.message : String(error),
        'UNKNOWN',
        { cause: error },
      );
    }
  }

  /**
   * Stream Copilot Workspace status updates (implements abstract method).
   *
   * Creates a workspace and yields status updates as stream chunks.
   */
  protected async *doInvokeStream(
    prompt: string,
    options: InternalInvokeOptions,
  ): AsyncIterableIterator<StreamChunk> {
    this.ensureNotDisposed();

    // Extract issue URL from prompt or metadata
    const issueUrl = this.extractIssueUrl(prompt, options.metadata);
    if (!issueUrl) {
      throw new FacetError(
        'Prompt must contain or metadata must include an issueUrl for Copilot Workspace',
        'VALIDATION',
      );
    }

    this.logger.debug({ issueUrl, invocationId: options.invocationId }, 'Starting Copilot stream');

    // Create workspace for tracking
    const workspace = await this.workspaceManager.createWorkspace({
      issueUrl,
    });

    yield {
      text: `Workspace created: ${workspace.id}\n`,
      metadata: { workspaceId: workspace.id, status: 'created' },
    };

    // Stream status updates until terminal state (merged, failed, not_available)
    for await (const event of this.workspaceManager.streamStatus(workspace.id)) {
      if (options.signal.aborted) {
        break;
      }

      yield {
        text: `Status: ${event.previousStatus} → ${event.status}\n`,
        metadata: {
          workspaceId: workspace.id,
          previousStatus: event.previousStatus,
          status: event.status,
          timestamp: event.timestamp.toISOString(),
        },
      };

      if (event.status === 'merged' || event.status === 'failed' || event.status === 'not_available') {
        break;
      }
    }

    // Yield final changes if merged
    const status = await this.workspaceManager.pollWorkspaceStatus(workspace.id);
    if (status === 'merged') {
      const changes = await this.workspaceManager.getChanges(workspace.id);
      yield {
        text: `\nCompleted with ${changes.length} file changes\n`,
        metadata: { changes: changes.map((c) => ({ path: c.path, type: c.type })) },
      };
    }
  }

  /**
   * Return Copilot Workspace capabilities (implements abstract method).
   */
  protected async doGetCapabilities(): Promise<AgentCapabilities> {
    return {
      streaming: true,
      cancellation: true,
      models: ['copilot-workspace'],
    };
  }

  // ==========================================================================
  // Copilot-specific public API (for backwards compatibility)
  // ==========================================================================

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

  // ==========================================================================
  // Private helper methods
  // ==========================================================================

  private ensureNotDisposed(): void {
    if (this.isDisposed) {
      throw new FacetError('Plugin has been disposed', 'VALIDATION');
    }
  }

  /**
   * Extract issue URL from prompt text or metadata.
   */
  private extractIssueUrl(prompt: string, metadata?: Record<string, unknown>): string | null {
    // Check metadata first
    if (metadata?.issueUrl && typeof metadata.issueUrl === 'string') {
      return metadata.issueUrl;
    }

    // Try to extract from prompt text (GitHub issue URL pattern)
    const urlMatch = prompt.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/);
    if (urlMatch) {
      return urlMatch[0];
    }

    return null;
  }
}
