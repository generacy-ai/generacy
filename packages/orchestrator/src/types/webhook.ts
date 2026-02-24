/**
 * Minimal GitHub webhook response type.
 * Only includes fields needed for matching and reactivation.
 */
export interface GitHubWebhook {
  /** Webhook ID */
  id: number;
  /** Whether webhook is active */
  active: boolean;
  /** Webhook configuration */
  config: {
    /** Target URL */
    url: string;
  };
  /** Event types webhook subscribes to */
  events: string[];
}

/**
 * Summary of webhook setup operation across multiple repositories
 */
export interface WebhookSetupSummary {
  /** Total repositories checked */
  total: number;
  /** Webhooks created */
  created: number;
  /** Webhooks skipped (already exist) */
  skipped: number;
  /** Webhooks reactivated */
  reactivated: number;
  /** Repositories that failed */
  failed: number;
  /** Per-repository results */
  results: WebhookSetupResult[];
}

/**
 * Result of webhook setup for a single repository
 */
export interface WebhookSetupResult {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Action taken */
  action: 'created' | 'skipped' | 'reactivated' | 'failed';
  /** Webhook ID (if applicable) */
  webhookId?: number;
  /** Error message (if action === 'failed') */
  error?: string;
}

/**
 * Repository configuration for webhook setup
 */
export interface RepositoryConfig {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
}
