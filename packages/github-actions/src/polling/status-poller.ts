import type { GitHubClient } from '../client.js';
import type { WorkflowRun } from '../types/workflows.js';
import { isTerminalStatus } from '../types/workflows.js';
import { getWorkflowRun } from '../operations/runs.js';
import { PollingTimeoutError, RateLimitError } from '../utils/errors.js';
import type { PollingConfig, PollingResult, PollingHandle } from './types.js';
import { createPollingConfig } from './types.js';

/**
 * Status poller for monitoring workflow run status changes
 */
export class StatusPoller {
  private readonly client: GitHubClient;
  private readonly config: PollingConfig;
  private cancelled = false;

  constructor(client: GitHubClient, config?: Partial<PollingConfig>) {
    this.client = client;
    this.config = createPollingConfig(config);
  }

  /**
   * Poll for workflow run status until it reaches a terminal state
   *
   * @param runId - Workflow run ID to monitor
   * @returns Polling result with final run state
   */
  async poll(runId: number): Promise<PollingResult> {
    let attempts = 0;
    let lastRun: WorkflowRun | null = null;
    let lastStatus: string | null = null;
    let currentInterval = this.config.interval;

    while (attempts < this.config.maxAttempts && !this.cancelled) {
      attempts++;
      this.config.onPoll?.(attempts, this.config.maxAttempts);

      try {
        const run = await getWorkflowRun(this.client, runId);
        lastRun = run;

        // Check if status changed
        if (lastStatus !== run.status) {
          lastStatus = run.status;
          this.config.onUpdate?.(run);
        }

        // Check for terminal state
        if (isTerminalStatus(run.status)) {
          this.config.onComplete?.(run);
          return {
            completed: true,
            run,
            attempts,
            timedOut: false,
          };
        }

        // Reset interval on successful poll
        currentInterval = this.config.interval;
      } catch (error) {
        if (error instanceof RateLimitError) {
          // Use exponential backoff on rate limit
          currentInterval = Math.min(
            currentInterval * 2,
            error.getTimeUntilReset() + 1000
          );
          this.config.onError?.(error);
        } else if (error instanceof Error) {
          this.config.onError?.(error);
          throw error;
        } else {
          throw error;
        }
      }

      // Wait before next poll
      if (!this.cancelled && attempts < this.config.maxAttempts) {
        await this.delay(currentInterval);
      }
    }

    // Polling timed out or was cancelled
    if (this.cancelled && lastRun) {
      return {
        completed: false,
        run: lastRun,
        attempts,
        timedOut: false,
      };
    }

    if (lastRun) {
      throw new PollingTimeoutError(runId, this.config.maxAttempts);
    }

    throw new Error(`Failed to get workflow run ${runId}`);
  }

  /**
   * Start polling and return a handle for control
   *
   * @param runId - Workflow run ID to monitor
   * @returns Polling handle with promise and cancel function
   */
  start(runId: number): PollingHandle {
    let active = true;

    const promise = this.poll(runId).finally(() => {
      active = false;
    });

    return {
      promise,
      cancel: () => {
        this.cancelled = true;
        active = false;
      },
      isActive: () => active,
    };
  }

  /**
   * Cancel any active polling
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Delay for the specified duration
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a new status poller
 */
export function createStatusPoller(
  client: GitHubClient,
  config?: Partial<PollingConfig>
): StatusPoller {
  return new StatusPoller(client, config);
}

/**
 * Poll for a workflow run to complete
 *
 * @param client - GitHub API client
 * @param runId - Workflow run ID
 * @param config - Optional polling configuration
 * @returns The completed workflow run
 */
export async function pollUntilComplete(
  client: GitHubClient,
  runId: number,
  config?: Partial<PollingConfig>
): Promise<WorkflowRun> {
  const poller = createStatusPoller(client, config);
  const result = await poller.poll(runId);
  return result.run;
}

/**
 * Wait for a workflow run with timeout
 *
 * @param client - GitHub API client
 * @param runId - Workflow run ID
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param intervalMs - Polling interval in milliseconds
 * @returns The workflow run (may not be complete if timeout reached)
 */
export async function waitForRun(
  client: GitHubClient,
  runId: number,
  timeoutMs: number = 600000,
  intervalMs: number = 10000
): Promise<PollingResult> {
  const maxAttempts = Math.ceil(timeoutMs / intervalMs);
  const poller = createStatusPoller(client, {
    interval: intervalMs,
    maxAttempts,
  });

  try {
    return await poller.poll(runId);
  } catch (error) {
    if (error instanceof PollingTimeoutError) {
      const run = await getWorkflowRun(client, runId);
      return {
        completed: false,
        run,
        attempts: maxAttempts,
        timedOut: true,
      };
    }
    throw error;
  }
}
