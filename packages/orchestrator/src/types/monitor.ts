/**
 * Queue item for workflow processing
 */
export interface QueueItem {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Issue number */
  issueNumber: number;
  /** Workflow name parsed from label (e.g., "speckit-feature") */
  workflowName: string;
  /** Command type: "process" for new, "continue" for resume */
  command: 'process' | 'continue';
  /** Priority score (timestamp for FIFO, lower = higher priority) */
  priority: number;
  /** When this item was enqueued */
  enqueuedAt: string;
}

/**
 * Parsed label event from webhook or polling
 */
export interface LabelEvent {
  /** Event type */
  type: 'process' | 'resume';
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Issue number */
  issueNumber: number;
  /** Full label name (e.g., "process:speckit-feature") */
  labelName: string;
  /** Parsed workflow/phase name */
  parsedName: string;
  /** Source of detection */
  source: 'webhook' | 'poll';
}

/**
 * GitHub webhook payload for issues.labeled events
 */
export interface GitHubWebhookPayload {
  action: string;
  label: {
    name: string;
    color: string;
    description: string;
  };
  issue: {
    number: number;
    title: string;
    labels: Array<{ name: string }>;
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
}

/**
 * Internal state tracked by the monitor service
 */
export interface MonitorState {
  /** Whether the polling loop is running */
  isPolling: boolean;
  /** Whether webhook endpoint has received events recently */
  webhookHealthy: boolean;
  /** Timestamp of last webhook event received */
  lastWebhookEvent: number | null;
  /** Current effective poll interval (adaptive) */
  currentPollIntervalMs: number;
  /** Configured base poll interval */
  basePollIntervalMs: number;
}

/**
 * Queue adapter interface for enqueuing items
 */
export interface QueueAdapter {
  enqueue(item: QueueItem): Promise<void>;
}

/**
 * Phase tracker interface for deduplication
 */
export interface PhaseTracker {
  isDuplicate(owner: string, repo: string, issue: number, phase: string): Promise<boolean>;
  markProcessed(owner: string, repo: string, issue: number, phase: string): Promise<void>;
}
