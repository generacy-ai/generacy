/**
 * WebhookSetupService
 *
 * Ensures GitHub webhooks are configured for all monitored repositories when
 * SMEE_CHANNEL_URL is set. Verifies existing webhooks, creates missing ones,
 * and reactivates inactive webhooks on orchestrator startup.
 *
 * This eliminates manual webhook configuration and ensures near-instant label
 * detection via Smee instead of relying on 15-minute polling fallback.
 */
import { executeCommand } from '@generacy-ai/workflow-engine';

/**
 * Logger interface matching Pino/Fastify logger shape.
 *
 * Supports both simple string messages and structured logging with context objects.
 */
interface Logger {
  /** Log informational message */
  info(msg: string): void;
  /** Log informational message with structured context */
  info(obj: Record<string, unknown>, msg: string): void;
  /** Log warning message */
  warn(msg: string): void;
  /** Log warning message with structured context */
  warn(obj: Record<string, unknown>, msg: string): void;
  /** Log error message */
  error(msg: string): void;
  /** Log error message with structured context */
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Repository configuration for webhook setup.
 *
 * Identifies a GitHub repository by owner and name for webhook management.
 */
export interface RepositoryConfig {
  /** Repository owner (organization or user) */
  owner: string;
  /** Repository name */
  repo: string;
}

/**
 * Minimal GitHub webhook response type.
 *
 * Only includes fields needed for matching and reactivation.
 * See: https://docs.github.com/en/rest/webhooks/repos#list-repository-webhooks
 */
export interface GitHubWebhook {
  /** Webhook ID (unique identifier) */
  id: number;
  /** Whether webhook is active (receiving events) */
  active: boolean;
  /** Webhook configuration */
  config: {
    /** Target URL where webhook events are sent */
    url: string;
  };
  /** Event types webhook subscribes to (e.g., ["issues", "pull_request"]) */
  events: string[];
}

/**
 * Result of webhook setup for a single repository.
 *
 * Captures the action taken and any relevant details or errors.
 */
export interface WebhookSetupResult {
  /** Repository owner (organization or user) */
  owner: string;
  /** Repository name */
  repo: string;
  /**
   * Action taken during webhook setup
   * - `created`: New webhook was created
   * - `skipped`: Active webhook already exists
   * - `reactivated`: Inactive webhook was reactivated
   * - `failed`: Setup failed (see `error` field)
   */
  action: 'created' | 'skipped' | 'reactivated' | 'failed';
  /** Webhook ID (present for created/skipped/reactivated, absent for failed) */
  webhookId?: number;
  /** Error message (only present when action === 'failed') */
  error?: string;
}

/**
 * Summary of webhook setup across all repositories.
 *
 * Provides aggregate counts and detailed per-repository results.
 */
export interface WebhookSetupSummary {
  /** Total number of repositories checked */
  total: number;
  /** Number of webhooks created (new) */
  created: number;
  /** Number of webhooks skipped (already active) */
  skipped: number;
  /** Number of webhooks reactivated (was inactive) */
  reactivated: number;
  /** Number of repositories that failed webhook setup */
  failed: number;
  /** Detailed results for each repository */
  results: WebhookSetupResult[];
}

/**
 * Service for auto-configuring GitHub webhooks for monitored repositories.
 *
 * When SMEE_CHANNEL_URL is configured, this service verifies and creates
 * GitHub webhooks for all monitored repositories on orchestrator startup,
 * ensuring near-instant label detection via Smee instead of 15-minute polling.
 *
 * Features:
 * - Creates missing webhooks pointing to Smee channel URL
 * - Skips existing active webhooks (idempotent)
 * - Reactivates inactive webhooks and merges events
 * - Graceful error handling (per-repo failures don't block startup)
 * - Warns on event mismatches without modifying
 * - Validates Smee URL format (warns on non-smee.io URLs)
 *
 * Error Handling:
 * - 403/404 errors: Logged as warnings, system falls back to polling
 * - Network/API errors: Logged and continue with next repo
 * - All errors are non-fatal and don't block orchestrator startup
 */
export class WebhookSetupService {
  private readonly _logger: Logger;
  private readonly _tokenProvider?: () => Promise<string | undefined>;

  /**
   * Creates a new WebhookSetupService instance.
   *
   * @param logger - Logger instance for structured logging (Pino/Fastify compatible)
   * @param tokenProvider - Optional async function returning a GH_TOKEN for auth
   */
  constructor(
    logger: Logger,
    tokenProvider?: () => Promise<string | undefined>,
  ) {
    this._logger = logger;
    this._tokenProvider = tokenProvider;
  }

  private async resolveTokenEnv(): Promise<Record<string, string> | undefined> {
    if (!this._tokenProvider) return undefined;
    const token = await this._tokenProvider();
    return token ? { GH_TOKEN: token } : undefined;
  }

  /**
   * Ensure webhooks exist for all repositories.
   *
   * This is the main entry point for webhook setup. For each repository:
   * 1. Lists existing webhooks via GitHub API
   * 2. Checks if a webhook already exists for the Smee channel URL
   * 3. Creates missing webhooks, reactivates inactive ones, or skips active ones
   * 4. Logs results and continues on errors (graceful degradation)
   *
   * Per-repository errors are logged but don't block the overall process,
   * allowing partial success when some repositories fail (e.g., due to
   * insufficient permissions).
   *
   * @param smeeChannelUrl - The Smee channel URL to configure webhooks for
   *                         (e.g., 'https://smee.io/abc123'). URL is validated
   *                         and a warning is logged if it doesn't point to smee.io.
   * @param repositories - List of repositories to ensure webhooks for. Each
   *                       repository is processed sequentially to avoid rate limits.
   * @returns Promise resolving to a summary of webhook setup results, including
   *          aggregate counts and detailed per-repository results.
   *
   * @example
   * ```typescript
   * const service = new WebhookSetupService(logger);
   * const summary = await service.ensureWebhooks(
   *   'https://smee.io/abc123',
   *   [
   *     { owner: 'myorg', repo: 'myrepo' },
   *     { owner: 'myorg', repo: 'another-repo' }
   *   ]
   * );
   * console.log(`Created: ${summary.created}, Skipped: ${summary.skipped}, Failed: ${summary.failed}`);
   * ```
   *
   * @see {@link WebhookSetupSummary} for the structure of the returned summary
   */
  async ensureWebhooks(
    smeeChannelUrl: string,
    repositories: RepositoryConfig[]
  ): Promise<WebhookSetupSummary> {
    // Validate Smee URL (warn if not smee.io)
    const normalizedUrl = smeeChannelUrl.toLowerCase();
    if (!normalizedUrl.startsWith('https://smee.io/')) {
      this._logger.warn(
        { smeeChannelUrl },
        'SMEE_CHANNEL_URL does not point to smee.io — ensure this URL is correct'
      );
    }

    // Initialize counters
    const results: WebhookSetupResult[] = [];
    let created = 0;
    let skipped = 0;
    let reactivated = 0;
    let failed = 0;

    // Process each repository
    for (const repo of repositories) {
      const result = await this._ensureWebhookForRepo(
        repo.owner,
        repo.repo,
        smeeChannelUrl
      );

      results.push(result);

      // Update counters based on action
      switch (result.action) {
        case 'created':
          created++;
          break;
        case 'skipped':
          skipped++;
          break;
        case 'reactivated':
          reactivated++;
          break;
        case 'failed':
          failed++;
          break;
      }
    }

    // Return summary
    return {
      total: repositories.length,
      created,
      skipped,
      reactivated,
      failed,
      results,
    };
  }

  /**
   * Ensure webhook exists for a single repository.
   *
   * Internal method that handles webhook verification and setup for one repository.
   * All errors are caught and converted to a 'failed' result to allow graceful
   * degradation.
   *
   * Logic flow:
   * 1. List existing webhooks
   * 2. Find webhook matching the Smee URL (case-insensitive)
   * 3. If not found: Create new webhook → 'created'
   * 4. If found and active: Skip → 'skipped' (warn on event mismatch)
   * 5. If found but inactive: Reactivate and merge events → 'reactivated'
   *
   * @param owner - Repository owner (organization or user)
   * @param repo - Repository name
   * @param smeeChannelUrl - The Smee channel URL to configure
   * @returns Promise resolving to the result of webhook setup for this repository
   *
   * @throws Never throws - all errors are caught and returned as 'failed' results
   */
  private async _ensureWebhookForRepo(
    owner: string,
    repo: string,
    smeeChannelUrl: string
  ): Promise<WebhookSetupResult> {
    try {
      // List existing webhooks
      const existingWebhooks = await this._listRepoWebhooks(owner, repo);

      // Check for matching webhook
      const matchingWebhook = this._findMatchingWebhook(
        existingWebhooks,
        smeeChannelUrl
      );

      // No matching webhook - create new one
      if (!matchingWebhook) {
        const webhookId = await this._createRepoWebhook(
          owner,
          repo,
          smeeChannelUrl
        );

        this._logger.info(
          { owner, repo, webhookId, action: 'created' },
          'Created new webhook for repository'
        );

        return {
          owner,
          repo,
          action: 'created',
          webhookId,
        };
      }

      // Matching webhook exists and is active
      if (matchingWebhook.active) {
        // Check for event mismatch
        const hasIssuesEvent = matchingWebhook.events.includes('issues');

        if (!hasIssuesEvent) {
          this._logger.warn(
            {
              owner,
              repo,
              webhookId: matchingWebhook.id,
              currentEvents: matchingWebhook.events,
              expectedEvents: ['issues'],
            },
            'Existing webhook has event mismatch - events not updated'
          );
        }

        this._logger.info(
          { owner, repo, webhookId: matchingWebhook.id, action: 'skipped' },
          'Webhook already exists and is active'
        );

        return {
          owner,
          repo,
          action: 'skipped',
          webhookId: matchingWebhook.id,
        };
      }

      // Matching webhook exists but is inactive - reactivate and merge events
      const mergedEvents = [
        ...new Set([...matchingWebhook.events, 'issues']),
      ];

      await this._updateRepoWebhook(owner, repo, matchingWebhook.id, {
        active: true,
        events: mergedEvents,
      });

      this._logger.info(
        {
          owner,
          repo,
          webhookId: matchingWebhook.id,
          action: 'reactivated',
          events: mergedEvents,
        },
        'Reactivated inactive webhook'
      );

      return {
        owner,
        repo,
        action: 'reactivated',
        webhookId: matchingWebhook.id,
      };
    } catch (error) {
      // Handle per-repo errors gracefully
      const errorMessage = String(error);

      // Determine appropriate log level and message based on error type
      if (errorMessage.includes('403') || errorMessage.includes('404')) {
        this._logger.warn(
          { owner, repo, error: errorMessage },
          'Insufficient permissions to manage webhooks (admin:repo_hook required)'
        );
      } else if (errorMessage.includes('500')) {
        this._logger.warn(
          { owner, repo, error: errorMessage },
          'GitHub API error while managing webhooks'
        );
      } else {
        this._logger.warn(
          { owner, repo, error: errorMessage },
          'Failed to manage webhook for repository'
        );
      }

      return {
        owner,
        repo,
        action: 'failed',
        error: errorMessage,
      };
    }
  }

  /**
   * Find a webhook matching the given URL.
   *
   * Uses case-insensitive URL comparison. No URL normalization is performed -
   * simple string matching after lowercasing both URLs. This means that
   * 'https://smee.io/ABC' and 'https://smee.io/abc' are considered equal,
   * but trailing slashes or different protocols would not match.
   *
   * @param webhooks - Array of webhooks to search through
   * @param targetUrl - The URL to match (typically the Smee channel URL)
   * @returns The first matching webhook, or undefined if none found
   *
   * @example
   * ```typescript
   * const webhooks = [
   *   { id: 1, active: true, config: { url: 'https://smee.io/ABC' }, events: ['issues'] }
   * ];
   * const match = this._findMatchingWebhook(webhooks, 'https://smee.io/abc');
   * // Returns the webhook with id: 1
   * ```
   */
  private _findMatchingWebhook(
    webhooks: GitHubWebhook[],
    targetUrl: string
  ): GitHubWebhook | undefined {
    const normalizedTargetUrl = targetUrl.toLowerCase();

    return webhooks.find((webhook) => {
      const webhookUrl = webhook.config?.url?.toLowerCase() ?? '';
      return webhookUrl === normalizedTargetUrl;
    });
  }

  /**
   * List webhooks for a repository via GitHub API.
   *
   * Uses the `gh` CLI to call `GET /repos/{owner}/{repo}/hooks`.
   * Errors are logged and an empty array is returned for graceful degradation.
   *
   * @param owner - Repository owner (organization or user)
   * @param repo - Repository name
   * @returns Promise resolving to an array of webhooks (empty array on error)
   *
   * @see {@link https://docs.github.com/en/rest/webhooks/repos#list-repository-webhooks}
   */
  private async _listRepoWebhooks(
    owner: string,
    repo: string
  ): Promise<GitHubWebhook[]> {
    try {
      const env = await this.resolveTokenEnv();
      const result = await executeCommand('gh', [
        'api',
        `/repos/${owner}/${repo}/hooks`,
      ], { env });

      if (result.exitCode !== 0) {
        this._logger.warn(
          { owner, repo, stderr: result.stderr },
          'Failed to list webhooks for repository'
        );
        return [];
      }

      // Parse JSON response
      const parsed = JSON.parse(result.stdout) as unknown;

      // Validate the response is an array
      if (!Array.isArray(parsed)) {
        this._logger.warn(
          { owner, repo, response: result.stdout },
          'Unexpected response format when listing webhooks (expected array)'
        );
        return [];
      }

      // Return as GitHubWebhook array (minimal validation - trust GitHub API)
      return parsed as GitHubWebhook[];
    } catch (error) {
      // Handle parse errors and other exceptions gracefully
      this._logger.warn(
        { owner, repo, error: String(error) },
        'Error listing webhooks for repository'
      );
      return [];
    }
  }

  /**
   * Create a new webhook for a repository via GitHub API.
   *
   * Uses the `gh` CLI to call `POST /repos/{owner}/{repo}/hooks` with:
   * - `config.url`: The Smee channel URL
   * - `config.content_type`: 'json'
   * - `events`: ['issues']
   * - `active`: true
   *
   * @param owner - Repository owner (organization or user)
   * @param repo - Repository name
   * @param smeeChannelUrl - The Smee channel URL to configure
   * @returns Promise resolving to the webhook ID on success
   * @throws Error if webhook creation fails (caught and logged by caller)
   *
   * @see {@link https://docs.github.com/en/rest/webhooks/repos#create-a-repository-webhook}
   */
  private async _createRepoWebhook(
    owner: string,
    repo: string,
    smeeChannelUrl: string
  ): Promise<number> {
    const env = await this.resolveTokenEnv();
    const result = await executeCommand('gh', [
      'api',
      '-X', 'POST',
      `/repos/${owner}/${repo}/hooks`,
      '-f', `config[url]=${smeeChannelUrl}`,
      '-f', 'config[content_type]=json',
      '-F', 'events[]=issues',
      '-F', 'active=true',
    ], { env });

    if (result.exitCode !== 0) {
      // Extract error message from stderr for better debugging
      const errorMsg = result.stderr.trim() || 'Unknown error';
      throw new Error(`Failed to create webhook: ${errorMsg}`);
    }

    // Parse response to get webhook ID
    const response = JSON.parse(result.stdout) as { id: number };
    return response.id;
  }

  /**
   * Update an existing webhook (reactivate and/or merge events) via GitHub API.
   *
   * Uses the `gh` CLI to call `PATCH /repos/{owner}/{repo}/hooks/{webhookId}`.
   * When reactivating an inactive webhook, this method also merges the 'issues'
   * event with any existing events to preserve the webhook's original configuration.
   *
   * @param owner - Repository owner (organization or user)
   * @param repo - Repository name
   * @param webhookId - Webhook ID to update
   * @param updates - Updates to apply
   * @param updates.active - Set webhook active status (true to reactivate)
   * @param updates.events - Event types to subscribe to (merged with existing)
   * @returns Promise resolving to true on success
   * @throws Error if webhook update fails (caught and logged by caller)
   *
   * @see {@link https://docs.github.com/en/rest/webhooks/repos#update-a-repository-webhook}
   */
  private async _updateRepoWebhook(
    owner: string,
    repo: string,
    webhookId: number,
    updates: { active?: boolean; events?: string[] }
  ): Promise<boolean> {
    // Build gh api command arguments
    const args = [
      'api',
      '-X', 'PATCH',
      `/repos/${owner}/${repo}/hooks/${webhookId}`,
    ];

    // Add active flag if specified
    if (updates.active !== undefined) {
      args.push('-F', `active=${updates.active}`);
    }

    // Add events if specified (merge with existing)
    if (updates.events && updates.events.length > 0) {
      // GitHub expects events as an array, so we need to add each event
      updates.events.forEach((event) => {
        args.push('-F', `events[]=${event}`);
      });
    }

    const env = await this.resolveTokenEnv();
    const result = await executeCommand('gh', args, { env });

    if (result.exitCode !== 0) {
      // Extract error message from stderr for better debugging
      const errorMsg = result.stderr.trim() || 'Unknown error';
      throw new Error(`Failed to update webhook: ${errorMsg}`);
    }

    return true;
  }
}
