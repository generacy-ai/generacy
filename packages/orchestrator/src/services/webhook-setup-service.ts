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
import { readFile } from 'node:fs/promises';
import { executeCommand } from '@generacy-ai/workflow-engine';
import { JitTokenError } from '@generacy-ai/control-plane';
import type { ClusterStatus } from './status-reporter.js';

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
   * - `skipped`: Active webhook already exists (or a foreign hook was left alone)
   * - `reactivated`: Inactive webhook was reactivated, or persisted-URL match PATCHed
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
  /** Number of webhooks reactivated (was inactive or persisted-URL healed) */
  reactivated: number;
  /** Number of repositories that failed webhook setup */
  failed: number;
  /** Detailed results for each repository */
  results: WebhookSetupResult[];
}

/** Locked event set on all Generacy-created/updated webhooks (FR-001). */
const LOCKED_EVENTS = ['issues', 'pull_request', 'check_run', 'check_suite'] as const;

/** Default location of the persisted smee channel URL (written by SmeeChannelResolver). */
const DEFAULT_CHANNEL_FILE_PATH = '/var/lib/generacy/smee-channel';

/** StatusReporter surface the service depends on (kept minimal for DI). */
interface StatusReporterLike {
  pushStatus(status: ClusterStatus, reason: string): Promise<void>;
}

/**
 * Constructor options bundle for optional dependency-injection hooks.
 *
 * All fields are optional so existing callers (and the pre-#972 test suite)
 * keep working. When a hook is absent the corresponding side-effect degrades
 * to a no-op, matching pre-#972 behavior.
 */
export interface WebhookSetupServiceOptions {
  /**
   * Fires `cluster.bootstrap` relay events on webhook-registration 403.
   * Payload shape per `contracts/webhook-registration-forbidden-event.md`.
   */
  sendRelayEvent?: (channel: string, payload: unknown) => void;
  /**
   * Pushes `degraded` cluster status on webhook-registration 403.
   * Payload shape per `contracts/degraded-status-transition.md`.
   */
  statusReporter?: StatusReporterLike;
  /** Path to the persisted smee channel URL file. Defaults to `/var/lib/generacy/smee-channel`. */
  channelFilePath?: string;
  /** Resolves the current github-app installation id for the 403 event payload. */
  installationIdProvider?: () => Promise<number | null>;
}

/**
 * Service for auto-configuring GitHub webhooks for monitored repositories.
 *
 * When SMEE_CHANNEL_URL is configured, this service verifies and creates
 * GitHub webhooks for all monitored repositories on orchestrator startup,
 * ensuring near-instant label detection via Smee instead of 15-minute polling.
 */
export class WebhookSetupService {
  private readonly _logger: Logger;
  private readonly _tokenProvider?: () => Promise<string | undefined>;
  private readonly _sendRelayEvent?: (channel: string, payload: unknown) => void;
  private readonly _statusReporter?: StatusReporterLike;
  private readonly _channelFilePath: string;
  private readonly _installationIdProvider?: () => Promise<number | null>;

  /**
   * Set of `owner/repo` values for which the 403 fail-loud triple has already
   * fired within this orchestrator boot. Bounds cloud-side banner noise to
   * at most N events per boot for a cluster with N configured repos
   * (see `contracts/webhook-registration-forbidden-event.md` §"Emission rate").
   */
  private readonly _forbiddenFiredForRepo = new Set<string>();

  /**
   * Cached github-app installation id resolved once at startup via
   * `installationIdProvider`. `undefined` means "not yet resolved this boot";
   * `null` means "resolved, but no id available"; `number` means resolved.
   */
  private _installationIdCache: number | null | undefined;

  /**
   * Creates a new WebhookSetupService instance.
   *
   * @param logger - Logger instance for structured logging (Pino/Fastify compatible)
   * @param tokenProvider - Optional async function returning a GH_TOKEN for auth
   * @param options - Optional DI hooks for #972 fail-loud triple + FR-004 persisted-URL healing
   */
  constructor(
    logger: Logger,
    tokenProvider?: () => Promise<string | undefined>,
    options: WebhookSetupServiceOptions = {},
  ) {
    this._logger = logger;
    this._tokenProvider = tokenProvider;
    this._sendRelayEvent = options.sendRelayEvent;
    this._statusReporter = options.statusReporter;
    this._channelFilePath = options.channelFilePath ?? DEFAULT_CHANNEL_FILE_PATH;
    this._installationIdProvider = options.installationIdProvider;
  }

  /**
   * Invariant: when a tokenProvider is configured, the env override ALWAYS
   * carries a `GH_TOKEN` key — never `undefined`. Prevents the `gh` subprocess
   * from inheriting the orchestrator's ambient `GH_TOKEN`. If the provider
   * throws (e.g., `JitTokenError`), the throw propagates to the per-repo
   * try/catch in `_ensureWebhookForRepo`, which logs and continues.
   * See `specs/777-severity-high-773-not/contracts/gh-cli-env-override.md`.
   */
  private async resolveTokenEnv(): Promise<Record<string, string> | undefined> {
    if (!this._tokenProvider) return undefined;
    const token = await this._tokenProvider();
    return { GH_TOKEN: token ?? '' };
  }

  /**
   * Ensure webhooks exist for all repositories.
   *
   * For each repository, evaluates the decision matrix documented at
   * `specs/972-summary-snappoll-preview/contracts/ensure-webhooks-behavior.md`.
   * Per-repository errors are logged but don't block the overall process.
   *
   * @param smeeChannelUrl - The Smee channel URL to configure webhooks for
   * @param repositories - List of repositories to ensure webhooks for
   * @returns Promise resolving to a summary of webhook setup results
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

    // Read the persisted channel URL once per ensureWebhooks() invocation.
    // Used to detect the FR-004 stale-channel-rotation case (row 6 of the
    // decision matrix).
    const previouslyPersistedUrl = await this._readPersistedChannelUrl();

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
        smeeChannelUrl,
        previouslyPersistedUrl,
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
   * Implements rows 1-11 of the per-repo decision matrix in
   * `contracts/ensure-webhooks-behavior.md`.
   */
  private async _ensureWebhookForRepo(
    owner: string,
    repo: string,
    smeeChannelUrl: string,
    previouslyPersistedUrl: string | null,
  ): Promise<WebhookSetupResult> {
    // List existing webhooks. When list fails with 403, emit the fail-loud
    // triple; other list errors return a `failed` result with the raw stderr.
    let existingWebhooks: GitHubWebhook[];
    try {
      existingWebhooks = await this._listRepoWebhooks(owner, repo);
    } catch (error) {
      return this._handleGhFailure(
        owner,
        repo,
        error,
        'list',
        'Insufficient permissions to manage webhooks (admin:repo_hook required)',
      );
    }

    // FR-004 decision matrix: find whether to skip, reactivate, PATCH, log-and-skip, or create.
    const selection = this._selectExistingHookForUpdate(
      existingWebhooks,
      smeeChannelUrl,
      previouslyPersistedUrl,
    );

    if (selection.kind === 'skip-active') {
      const hook = selection.hook;
      const missingEvents = LOCKED_EVENTS.filter((e) => !hook.events.includes(e));
      if (missingEvents.length > 0) {
        this._logger.warn(
          {
            owner,
            repo,
            webhookId: hook.id,
            currentEvents: hook.events,
            expectedEvents: ['issues'],
          },
          'Existing webhook has event mismatch - events not updated'
        );
      }
      this._logger.info(
        { owner, repo, webhookId: hook.id, action: 'skipped' },
        'Webhook already exists and is active'
      );
      return { owner, repo, action: 'skipped', webhookId: hook.id };
    }

    if (selection.kind === 'reactivate') {
      const hook = selection.hook;
      const mergedEvents = [...new Set([...hook.events, 'issues'])];
      try {
        await this._updateRepoWebhook(owner, repo, hook.id, {
          active: true,
          events: mergedEvents,
        });
      } catch (error) {
        return this._handleGhFailure(
          owner,
          repo,
          error,
          'patch',
          'Failed to manage webhook for repository',
        );
      }
      this._logger.info(
        {
          owner,
          repo,
          webhookId: hook.id,
          action: 'reactivated',
          events: mergedEvents,
        },
        'Reactivated inactive webhook'
      );
      return { owner, repo, action: 'reactivated', webhookId: hook.id };
    }

    if (selection.kind === 'update-url') {
      const hook = selection.hook;
      try {
        await this._updateRepoWebhookConfig(owner, repo, hook.id, {
          url: smeeChannelUrl,
          active: true,
          events: [...LOCKED_EVENTS],
        });
      } catch (error) {
        return this._handleGhFailure(
          owner,
          repo,
          error,
          'patch',
          'Failed to manage webhook for repository',
        );
      }
      this._logger.info(
        {
          owner,
          repo,
          webhookId: hook.id,
          action: 'reactivated',
          oldUrl: hook.config?.url,
          newUrl: smeeChannelUrl,
          events: [...LOCKED_EVENTS],
        },
        'Updated Generacy webhook to current channel URL'
      );
      return { owner, repo, action: 'reactivated', webhookId: hook.id };
    }

    if (selection.kind === 'foreign') {
      const hook = selection.hook;
      const truncatedUrl = (hook.config?.url ?? '').slice(0, 80);
      this._logger.warn(
        { owner, repo, webhookId: hook.id, foreignUrl: truncatedUrl },
        'Foreign webhook present; not modifying'
      );
      return { owner, repo, action: 'skipped', webhookId: hook.id };
    }

    // selection.kind === 'create' — no existing hook match, POST a new one.
    let webhookId: number;
    try {
      webhookId = await this._createRepoWebhook(owner, repo, smeeChannelUrl);
    } catch (error) {
      return this._handleGhFailure(
        owner,
        repo,
        error,
        'create',
        'Failed to manage webhook for repository',
      );
    }

    this._logger.info(
      { owner, repo, webhookId, action: 'created' },
      'Created new webhook for repository'
    );
    return { owner, repo, action: 'created', webhookId };
  }

  /**
   * Read the previously-persisted smee channel URL from disk.
   *
   * Returns `null` on ENOENT, on empty content, or on any read/parse error.
   * Written only by `SmeeChannelResolver`; read-only here.
   */
  private async _readPersistedChannelUrl(): Promise<string | null> {
    try {
      const raw = await readFile(this._channelFilePath, 'utf8');
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  /**
   * Decision matrix for choosing what to do with the existing hook set.
   *
   * Implements rows 4-9 of `contracts/ensure-webhooks-behavior.md`. First
   * match wins. `matches(A, B)` is case-insensitive string equality per
   * `data-model.md` §"Field-Level Validation Rules Summary".
   */
  private _selectExistingHookForUpdate(
    hooks: GitHubWebhook[],
    currentUrl: string,
    persistedUrl: string | null,
  ):
    | { kind: 'skip-active'; hook: GitHubWebhook }
    | { kind: 'reactivate'; hook: GitHubWebhook }
    | { kind: 'update-url'; hook: GitHubWebhook }
    | { kind: 'foreign'; hook: GitHubWebhook }
    | { kind: 'create' } {
    const currentNormalized = currentUrl.toLowerCase();
    const persistedNormalized = persistedUrl?.toLowerCase() ?? null;

    // Row 4/5: hook whose config.url matches the CURRENT channel URL.
    const currentMatch = hooks.find(
      (h) => (h.config?.url?.toLowerCase() ?? '') === currentNormalized,
    );
    if (currentMatch) {
      return currentMatch.active
        ? { kind: 'skip-active', hook: currentMatch }
        : { kind: 'reactivate', hook: currentMatch };
    }

    // Row 6: hook whose config.url matches the PERSISTED (rotated) channel URL.
    if (
      persistedNormalized !== null &&
      persistedNormalized !== currentNormalized
    ) {
      const persistedMatch = hooks.find(
        (h) => (h.config?.url?.toLowerCase() ?? '') === persistedNormalized,
      );
      if (persistedMatch) {
        return { kind: 'update-url', hook: persistedMatch };
      }
    }

    // Row 8: existing foreign smee hook — do not touch, log-and-skip.
    // A hook is "foreign" when its URL is neither the current nor the persisted
    // Generacy channel URL. We only flag smee.io URLs to keep the signal
    // relevant (a random non-smee webhook is almost certainly the operator's).
    const foreign = hooks.find((h) => {
      const url = (h.config?.url ?? '').toLowerCase();
      if (!url) return false;
      if (url === currentNormalized) return false;
      if (persistedNormalized !== null && url === persistedNormalized) return false;
      return url.startsWith('https://smee.io/');
    });
    if (foreign) {
      return { kind: 'foreign', hook: foreign };
    }

    // Row 9: no match — POST a new hook.
    return { kind: 'create' };
  }

  /**
   * Detect whether a `gh api` failure is the 403 fail-loud case.
   *
   * Matches the two error patterns GitHub can return for the same underlying
   * failure mode: `HTTP 403` (canonical) and `Resource not accessible by
   * integration` (typical stderr wording). Both patterns fire for the same
   * missing-scope case; matching either is sufficient (case-insensitive
   * substring). See `contracts/webhook-registration-forbidden-event.md`
   * §"Trigger conditions".
   */
  private _isForbiddenError(stderr: string): boolean {
    const lower = stderr.toLowerCase();
    return (
      lower.includes('http 403') ||
      lower.includes('resource not accessible by integration')
    );
  }

  /**
   * Handle any `gh` failure (list, create, or patch) from within
   * `_ensureWebhookForRepo`. On 403 → emit the fail-loud triple; on 404/500
   * → warn-only; on all other errors → generic warn.
   *
   * Guarantees the log line is the audit floor (always fires); relay event +
   * status transition are best-effort per the contracts.
   */
  private _handleGhFailure(
    owner: string,
    repo: string,
    error: unknown,
    site: 'list' | 'create' | 'patch',
    genericMessage: string,
  ): WebhookSetupResult {
    const errorMessage = String(error);

    if (error instanceof JitTokenError) {
      this._logger.warn(
        { owner, repo, code: error.code, message: error.message, site },
        'JIT GitHub token refresh failed — skipping webhook setup for repository'
      );
      return { owner, repo, action: 'failed', error: errorMessage };
    }

    if (this._isForbiddenError(errorMessage)) {
      this._fireForbiddenTriple(owner, repo, errorMessage);
      return {
        owner,
        repo,
        action: 'failed',
        error: 'webhook-registration-forbidden',
      };
    }

    if (errorMessage.includes('403') || errorMessage.includes('404')) {
      this._logger.warn(
        { owner, repo, error: errorMessage, site },
        'Insufficient permissions to manage webhooks (admin:repo_hook required)'
      );
    } else if (errorMessage.includes('500')) {
      this._logger.warn(
        { owner, repo, error: errorMessage, site },
        'GitHub API error while managing webhooks'
      );
    } else {
      this._logger.warn(
        { owner, repo, error: errorMessage, site },
        genericMessage,
      );
    }

    return { owner, repo, action: 'failed', error: errorMessage };
  }

  /**
   * Emit the fail-loud triple (warn log + relay event + degraded status) for
   * a webhook-registration 403. Bounded to at most once per `(repo, boot)`
   * per `contracts/webhook-registration-forbidden-event.md` §"Emission rate".
   *
   * The log line is synchronous and always succeeds — this is the audit
   * floor. Relay event and status transition are fire-and-forget.
   */
  private _fireForbiddenTriple(owner: string, repo: string, ghStderr: string): void {
    const repoKey = `${owner}/${repo}`;
    if (this._forbiddenFiredForRepo.has(repoKey)) {
      // Already fired for this repo this boot — silence to bound cloud noise.
      // The individual `gh` failure is still surfaced via the caller's return.
      return;
    }
    this._forbiddenFiredForRepo.add(repoKey);

    // Resolve installation id best-effort. `undefined` means "not resolved
    // yet"; anything else (null or number) means "resolved" for this boot.
    this._resolveInstallationId()
      .then((installationId) => {
        // 1. Structured warn log — synchronous, audit-floor guarantee.
        this._logger.warn(
          {
            owner,
            repo,
            installationId,
            missingScope: 'admin:repo_hook',
            reason: 'webhook-registration-forbidden',
            ghStderr,
          },
          'Webhook registration forbidden: missing admin:repo_hook scope',
        );

        // 2. `cluster.bootstrap` relay event.
        if (this._sendRelayEvent) {
          try {
            this._sendRelayEvent('cluster.bootstrap', {
              status: 'failed',
              reason: 'webhook-registration-forbidden',
              repo: repoKey,
              installationId,
              missingScope: 'admin:repo_hook',
            });
          } catch {
            // fire-and-forget
          }
        }

        // 3. Cluster status → degraded.
        if (this._statusReporter) {
          this._statusReporter
            .pushStatus('degraded', 'webhook-registration-forbidden')
            .catch(() => {
              // fire-and-forget
            });
        }
      })
      .catch(() => {
        // Provider failure must not swallow the audit-floor log line — emit
        // with null installationId so operators still see the 403 signal.
        this._logger.warn(
          {
            owner,
            repo,
            installationId: null,
            missingScope: 'admin:repo_hook',
            reason: 'webhook-registration-forbidden',
            ghStderr,
          },
          'Webhook registration forbidden: missing admin:repo_hook scope',
        );
        if (this._sendRelayEvent) {
          try {
            this._sendRelayEvent('cluster.bootstrap', {
              status: 'failed',
              reason: 'webhook-registration-forbidden',
              repo: repoKey,
              installationId: null,
              missingScope: 'admin:repo_hook',
            });
          } catch {
            // fire-and-forget
          }
        }
        if (this._statusReporter) {
          this._statusReporter
            .pushStatus('degraded', 'webhook-registration-forbidden')
            .catch(() => {
              // fire-and-forget
            });
        }
      });
  }

  /**
   * Resolve the github-app installation id, caching the result for the process
   * lifetime. Returns `null` when no provider is configured or the provider
   * cannot resolve an id (per data-model.md, `null` is a valid emit value).
   */
  private async _resolveInstallationId(): Promise<number | null> {
    if (this._installationIdCache !== undefined) return this._installationIdCache;
    if (!this._installationIdProvider) {
      this._installationIdCache = null;
      return null;
    }
    try {
      const resolved = await this._installationIdProvider();
      this._installationIdCache = resolved ?? null;
    } catch {
      this._installationIdCache = null;
    }
    return this._installationIdCache;
  }

  /**
   * List webhooks for a repository via GitHub API.
   *
   * Errors are thrown so the per-repo catch branch can classify them as 403
   * (fail-loud) vs 404/500 (warn-only). Returns an empty array when the API
   * returns a well-formed non-array response.
   */
  private async _listRepoWebhooks(
    owner: string,
    repo: string
  ): Promise<GitHubWebhook[]> {
    const env = await this.resolveTokenEnv();
    const result = await executeCommand('gh', [
      'api',
      `/repos/${owner}/${repo}/hooks`,
    ], { env });

    if (result.exitCode !== 0) {
      // Surface stderr as the thrown error so the catch branch can classify
      // the failure (403 → fail-loud; else → warn). Preserves the pre-#972
      // warn log line for the 500/404/other cases via `_handleGhFailure`.
      const errorMsg = result.stderr.trim() || 'Unknown error';
      this._logger.warn(
        { owner, repo, stderr: result.stderr },
        'Failed to list webhooks for repository'
      );
      throw new Error(errorMsg);
    }

    // Parse JSON response
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      this._logger.warn(
        { owner, repo, error: String(error) },
        'Error listing webhooks for repository'
      );
      return [];
    }

    if (!Array.isArray(parsed)) {
      this._logger.warn(
        { owner, repo, response: result.stdout },
        'Unexpected response format when listing webhooks (expected array)'
      );
      return [];
    }

    return parsed as GitHubWebhook[];
  }

  /**
   * Create a new webhook for a repository via GitHub API.
   *
   * FR-001: locks the create-time event list to `issues`, `pull_request`,
   * `check_run`, `check_suite`. `content_type` is `json`; `active` is `true`.
   *
   * @see {@link https://docs.github.com/en/rest/webhooks/repos#create-a-repository-webhook}
   */
  private async _createRepoWebhook(
    owner: string,
    repo: string,
    smeeChannelUrl: string
  ): Promise<number> {
    const env = await this.resolveTokenEnv();
    const args = [
      'api',
      '-X', 'POST',
      `/repos/${owner}/${repo}/hooks`,
      '-f', `config[url]=${smeeChannelUrl}`,
      '-f', 'config[content_type]=json',
      '-F', 'active=true',
    ];
    for (const event of LOCKED_EVENTS) {
      args.push('-F', `events[]=${event}`);
    }

    const result = await executeCommand('gh', args, { env });

    if (result.exitCode !== 0) {
      const errorMsg = result.stderr.trim() || 'Unknown error';
      throw new Error(`Failed to create webhook: ${errorMsg}`);
    }

    const response = JSON.parse(result.stdout) as { id: number };
    return response.id;
  }

  /**
   * Update an existing webhook (reactivate and/or merge events) via GitHub API.
   *
   * Used for the `reactivate` decision-matrix row (inactive hook matching
   * current URL). Preserves pre-#972 argv ordering so the existing test
   * assertions (`build correct PATCH request with active flag and merged events`)
   * continue to pass.
   *
   * @see {@link https://docs.github.com/en/rest/webhooks/repos#update-a-repository-webhook}
   */
  private async _updateRepoWebhook(
    owner: string,
    repo: string,
    webhookId: number,
    updates: { active?: boolean; events?: string[] }
  ): Promise<boolean> {
    const args = [
      'api',
      '-X', 'PATCH',
      `/repos/${owner}/${repo}/hooks/${webhookId}`,
    ];

    if (updates.active !== undefined) {
      args.push('-F', `active=${updates.active}`);
    }

    if (updates.events && updates.events.length > 0) {
      updates.events.forEach((event) => {
        args.push('-F', `events[]=${event}`);
      });
    }

    const env = await this.resolveTokenEnv();
    const result = await executeCommand('gh', args, { env });

    if (result.exitCode !== 0) {
      const errorMsg = result.stderr.trim() || 'Unknown error';
      throw new Error(`Failed to update webhook: ${errorMsg}`);
    }

    return true;
  }

  /**
   * Update an existing webhook's `config.url` to the current channel (FR-004
   * stale-channel heal). Also enforces the locked events set and active flag.
   */
  private async _updateRepoWebhookConfig(
    owner: string,
    repo: string,
    webhookId: number,
    updates: { url: string; active: boolean; events: string[] },
  ): Promise<boolean> {
    const args = [
      'api',
      '-X', 'PATCH',
      `/repos/${owner}/${repo}/hooks/${webhookId}`,
      '-f', `config[url]=${updates.url}`,
      '-f', 'config[content_type]=json',
      '-F', `active=${updates.active}`,
    ];
    for (const event of updates.events) {
      args.push('-F', `events[]=${event}`);
    }

    const env = await this.resolveTokenEnv();
    const result = await executeCommand('gh', args, { env });

    if (result.exitCode !== 0) {
      const errorMsg = result.stderr.trim() || 'Unknown error';
      throw new Error(`Failed to update webhook: ${errorMsg}`);
    }

    return true;
  }
}
