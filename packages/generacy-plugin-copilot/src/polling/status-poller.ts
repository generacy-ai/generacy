/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Status polling with exponential backoff.
 */

import { PollingTimeoutError } from '../errors.js';
import { isTerminalStatus, type WorkspaceStatus, type WorkspaceStatusEvent } from '../types.js';
import {
  DEFAULT_POLLING_CONFIG,
  type PollingConfig,
  type PollResult,
  type PollState,
  type StatusCallback,
  type StatusChecker,
} from './types.js';

/**
 * Status poller with exponential backoff.
 */
export class StatusPoller {
  private readonly config: PollingConfig;
  private readonly workspaceId: string;

  constructor(workspaceId: string, config: Partial<PollingConfig> = {}) {
    this.workspaceId = workspaceId;
    this.config = { ...DEFAULT_POLLING_CONFIG, ...config };
  }

  /**
   * Poll until a terminal status is reached or timeout.
   */
  async pollUntilTerminal(
    checkStatus: StatusChecker,
    onStatusChange?: StatusCallback
  ): Promise<PollResult> {
    const state = this.createInitialState();
    let previousStatus: WorkspaceStatus = 'pending';
    let currentStatus: WorkspaceStatus = 'pending';

    while (state.isActive) {
      // Check timeout
      if (this.isTimedOut(state)) {
        throw new PollingTimeoutError(
          this.workspaceId,
          this.config.timeoutMs ?? 0,
          state.pollCount
        );
      }

      // Check max retries
      if (state.pollCount >= this.config.maxRetries) {
        state.isActive = false;
        break;
      }

      // Wait for next poll interval
      if (state.pollCount > 0) {
        await this.sleep(state.currentIntervalMs);
        state.currentIntervalMs = this.calculateNextInterval(state.currentIntervalMs);
      }

      // Poll status
      state.pollCount++;
      state.lastPolledAt = new Date();
      currentStatus = await checkStatus();

      // Notify on status change
      if (currentStatus !== previousStatus) {
        onStatusChange?.(currentStatus, previousStatus);
        previousStatus = currentStatus;
      }

      // Check for terminal status
      if (isTerminalStatus(currentStatus)) {
        state.isActive = false;
        break;
      }
    }

    const durationMs = Date.now() - state.startedAt.getTime();
    return {
      status: currentStatus,
      isTerminal: isTerminalStatus(currentStatus),
      pollCount: state.pollCount,
      durationMs,
    };
  }

  /**
   * Create an async generator that yields status events.
   */
  async *streamStatus(checkStatus: StatusChecker): AsyncGenerator<WorkspaceStatusEvent> {
    const state = this.createInitialState();
    let previousStatus: WorkspaceStatus = 'pending';
    let currentStatus: WorkspaceStatus = 'pending';

    while (state.isActive) {
      // Check timeout
      if (this.isTimedOut(state)) {
        throw new PollingTimeoutError(
          this.workspaceId,
          this.config.timeoutMs ?? 0,
          state.pollCount
        );
      }

      // Check max retries
      if (state.pollCount >= this.config.maxRetries) {
        state.isActive = false;
        break;
      }

      // Wait for next poll interval
      if (state.pollCount > 0) {
        await this.sleep(state.currentIntervalMs);
        state.currentIntervalMs = this.calculateNextInterval(state.currentIntervalMs);
      }

      // Poll status
      state.pollCount++;
      state.lastPolledAt = new Date();
      currentStatus = await checkStatus();

      // Yield status event if changed
      if (currentStatus !== previousStatus) {
        yield {
          workspaceId: this.workspaceId,
          previousStatus,
          status: currentStatus,
          timestamp: new Date(),
        };
        previousStatus = currentStatus;
      }

      // Check for terminal status
      if (isTerminalStatus(currentStatus)) {
        state.isActive = false;
        break;
      }
    }
  }

  /**
   * Single poll operation.
   */
  async pollOnce(checkStatus: StatusChecker): Promise<WorkspaceStatus> {
    return checkStatus();
  }

  private createInitialState(): PollState {
    return {
      pollCount: 0,
      currentIntervalMs: this.config.initialIntervalMs,
      startedAt: new Date(),
      isActive: true,
    };
  }

  private calculateNextInterval(currentInterval: number): number {
    const nextInterval = currentInterval * this.config.backoffMultiplier;
    return Math.min(nextInterval, this.config.maxIntervalMs);
  }

  private isTimedOut(state: PollState): boolean {
    if (!this.config.timeoutMs) {
      return false;
    }
    const elapsed = Date.now() - state.startedAt.getTime();
    return elapsed >= this.config.timeoutMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a status poller with the given configuration.
 */
export function createStatusPoller(
  workspaceId: string,
  config?: Partial<PollingConfig>
): StatusPoller {
  return new StatusPoller(workspaceId, config);
}
