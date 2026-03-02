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
  /** Command type: "process" for new, "continue" for resume, "address-pr-feedback" for PR review feedback */
  command: 'process' | 'continue' | 'address-pr-feedback';
  /** Priority score (timestamp for FIFO, lower = higher priority) */
  priority: number;
  /** When this item was enqueued */
  enqueuedAt: string;
  /** Optional metadata for command-specific data */
  metadata?: Record<string, unknown>;
}

/**
 * Metadata for the address-pr-feedback command
 */
export interface PrFeedbackMetadata {
  /** PR number on the repository */
  prNumber: number;
  /** IDs of unresolved review threads at detection time */
  reviewThreadIds: number[];
}

/**
 * Represents a PR review event from webhook or polling
 */
export interface PrReviewEvent {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** PR number */
  prNumber: number;
  /** PR body text */
  prBody: string;
  /** Head branch name */
  branchName: string;
  /** How this event was detected */
  source: 'webhook' | 'poll';
}

/**
 * Result of linking a PR to an orchestrated issue
 */
export interface PrToIssueLink {
  /** PR number */
  prNumber: number;
  /** Linked issue number */
  issueNumber: number;
  /** How the link was resolved */
  linkMethod: 'pr-body' | 'branch-name';
}

/**
 * GitHub webhook payload for pull_request_review and pull_request_review_comment events
 */
export interface GitHubPrReviewWebhookPayload {
  action: string;
  review?: {
    id: number;
    state: string;
    body: string | null;
    user: { login: string };
  };
  comment?: {
    id: number;
    body: string;
    path: string;
    line: number | null;
    user: { login: string };
    in_reply_to_id?: number;
  };
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    head: { ref: string; sha: string };
    base: { ref: string };
    state: string;
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
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
  /** All labels on the issue at detection time */
  issueLabels: string[];
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
    assignees: Array<{ login: string }>;
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
 * Queue item with its priority score, used for listing
 */
export interface QueueItemWithScore {
  item: QueueItem;
  score: number;
}

/**
 * Internal representation stored in Redis, adding retry tracking
 */
export interface SerializedQueueItem extends QueueItem {
  /** Number of times this item has been claimed and released */
  attemptCount: number;
  /** Unique key for deduplication in the sorted set */
  itemKey: string;
}

/**
 * Extended queue interface for dispatch operations.
 * The monitor only uses enqueue() via QueueAdapter.
 * The dispatcher and routes use the full QueueManager interface.
 */
export interface QueueManager extends QueueAdapter {
  /** Atomically claim the highest-priority item for a worker */
  claim(workerId: string): Promise<QueueItem | null>;
  /** Release a claimed item back to the pending queue */
  release(workerId: string, item: QueueItem): Promise<void>;
  /** Mark a claimed item as complete and remove it */
  complete(workerId: string, item: QueueItem): Promise<void>;
  /** Get the number of items in the pending queue */
  getQueueDepth(): Promise<number>;
  /** Get paginated list of pending items with scores */
  getQueueItems(offset: number, limit: number): Promise<QueueItemWithScore[]>;
  /** Get the number of currently active (claimed) workers */
  getActiveWorkerCount(): Promise<number>;
}

/**
 * Represents an active worker tracked by the dispatcher
 */
export interface WorkerInfo {
  /** Unique worker ID */
  workerId: string;
  /** The item being processed */
  item: QueueItem;
  /** When the worker started processing */
  startedAt: number;
  /** Heartbeat refresh interval handle */
  heartbeatInterval: NodeJS.Timeout;
  /** Promise resolving when the handler completes */
  promise: Promise<void>;
}

/**
 * Callback signature for processing queue items
 */
export type WorkerHandler = (item: QueueItem) => Promise<void>;

/**
 * Phase tracker interface for deduplication
 */
export interface PhaseTracker {
  isDuplicate(owner: string, repo: string, issue: number, phase: string): Promise<boolean>;
  markProcessed(owner: string, repo: string, issue: number, phase: string): Promise<void>;
  clear(owner: string, repo: string, issue: number, phase: string): Promise<void>;
  /**
   * Atomically check and mark as processed (SET NX).
   * Returns true if this call won the race (not a duplicate).
   * Returns false if already processed (duplicate).
   */
  tryMarkProcessed(owner: string, repo: string, issue: number, phase: string): Promise<boolean>;
}
