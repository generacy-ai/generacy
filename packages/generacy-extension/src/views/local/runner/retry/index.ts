/**
 * Retry manager for workflow step execution.
 * Wraps action execution with configurable retry and timeout behavior.
 */
import type { RetryConfig, WorkflowStep } from '../types';
import type { ActionHandler, ActionContext, ActionResult } from '../actions/types';
import {
  calculateBackoffDelay,
  parseDuration,
  formatDuration,
  type BackoffStrategy,
} from './strategies';

/**
 * Retry state tracking
 */
export interface RetryState {
  /** Current attempt number (1-indexed) */
  attempt: number;
  /** Errors from previous attempts */
  previousErrors: Error[];
  /** Next delay in milliseconds (if retrying) */
  nextDelay?: number;
  /** Whether more retries are available */
  canRetry: boolean;
}

/**
 * Retry execution result
 */
export interface RetryResult<T> {
  /** Final result */
  result: T;
  /** Number of attempts made */
  attempts: number;
  /** Total duration including retries */
  totalDuration: number;
  /** Errors from failed attempts */
  errors: Error[];
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 1,
  delay: 1000,
  backoff: 'exponential',
  maxDelay: 60000,
  jitter: 0.1,
};

/**
 * Parse retry configuration from step or workflow defaults
 */
export function parseRetryConfig(step: WorkflowStep): RetryConfig {
  if (!step.retry) {
    return DEFAULT_RETRY_CONFIG;
  }

  const config = step.retry;

  return {
    maxAttempts: config.maxAttempts ?? DEFAULT_RETRY_CONFIG.maxAttempts,
    delay: typeof config.delay === 'string'
      ? parseDuration(config.delay)
      : config.delay ?? DEFAULT_RETRY_CONFIG.delay,
    backoff: config.backoff ?? DEFAULT_RETRY_CONFIG.backoff,
    maxDelay: config.maxDelay !== undefined
      ? (typeof config.maxDelay === 'string'
          ? parseDuration(config.maxDelay)
          : config.maxDelay)
      : DEFAULT_RETRY_CONFIG.maxDelay,
    jitter: config.jitter ?? DEFAULT_RETRY_CONFIG.jitter,
  };
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Sleep aborted'));
      return;
    }

    const timeoutId = setTimeout(resolve, ms);

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        reject(new Error('Sleep aborted'));
      });
    }
  });
}

/**
 * Retry manager class
 * Wraps action execution with configurable retry behavior
 */
export class RetryManager {
  private config: RetryConfig;
  private onRetry?: (state: RetryState, error: Error) => void;

  constructor(
    config?: Partial<RetryConfig>,
    onRetry?: (state: RetryState, error: Error) => void
  ) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
    this.onRetry = onRetry;
  }

  /**
   * Execute an action with retry logic
   */
  async executeWithRetry(
    handler: ActionHandler,
    step: WorkflowStep,
    context: ActionContext
  ): Promise<RetryResult<ActionResult>> {
    const stepConfig = parseRetryConfig(step);
    const config = { ...this.config, ...stepConfig };
    const errors: Error[] = [];
    const startTime = Date.now();

    let attempt = 1;
    let lastResult: ActionResult | undefined;

    while (attempt <= config.maxAttempts) {
      const state: RetryState = {
        attempt,
        previousErrors: [...errors],
        canRetry: attempt < config.maxAttempts,
        nextDelay: attempt < config.maxAttempts
          ? calculateBackoffDelay(
              config.backoff as BackoffStrategy,
              attempt,
              config.delay,
              config.maxDelay,
              config.jitter
            )
          : undefined,
      };

      try {
        // Check for cancellation before each attempt
        if (context.signal.aborted) {
          throw new Error('Execution cancelled');
        }

        // Log attempt
        if (attempt > 1) {
          context.logger.info(
            `Retry attempt ${attempt}/${config.maxAttempts} for step "${step.name}"`
          );
        }

        // Execute the action
        lastResult = await handler.execute(step, context);

        // Check if successful
        if (lastResult.success) {
          return {
            result: lastResult,
            attempts: attempt,
            totalDuration: Date.now() - startTime,
            errors,
          };
        }

        // Action failed but didn't throw
        const error = new Error(lastResult.error || 'Action failed');
        errors.push(error);

        // Check if we can retry
        if (state.canRetry) {
          // Call retry callback
          if (this.onRetry) {
            this.onRetry(state, error);
          }

          // Wait before retrying
          context.logger.info(
            `Waiting ${formatDuration(state.nextDelay!)} before retry...`
          );
          await sleep(state.nextDelay!, context.signal);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);

        // Check for cancellation
        if (err.message.includes('cancelled') || err.message.includes('aborted')) {
          // Don't retry on cancellation
          return {
            result: lastResult ?? {
              success: false,
              output: null,
              error: err.message,
              duration: Date.now() - startTime,
            },
            attempts: attempt,
            totalDuration: Date.now() - startTime,
            errors,
          };
        }

        // Check if we can retry
        if (state.canRetry) {
          // Call retry callback
          if (this.onRetry) {
            this.onRetry(state, err);
          }

          // Wait before retrying
          context.logger.info(
            `Waiting ${formatDuration(state.nextDelay!)} before retry...`
          );
          await sleep(state.nextDelay!, context.signal);
        }
      }

      attempt++;
    }

    // All retries exhausted
    const finalError = errors[errors.length - 1];
    return {
      result: lastResult ?? {
        success: false,
        output: null,
        error: finalError?.message || 'Max retries exceeded',
        duration: Date.now() - startTime,
      },
      attempts: attempt - 1,
      totalDuration: Date.now() - startTime,
      errors,
    };
  }

  /**
   * Create a retry manager from step configuration
   */
  static fromStep(
    step: WorkflowStep,
    onRetry?: (state: RetryState, error: Error) => void
  ): RetryManager {
    return new RetryManager(parseRetryConfig(step), onRetry);
  }
}

/**
 * Create a timeout wrapper for an async operation
 */
export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    // Check if already aborted
    if (signal?.aborted) {
      reject(new Error('Operation aborted'));
      return;
    }

    let settled = false;
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Operation timed out after ${formatDuration(timeoutMs)}`));
      }
    }, timeoutMs);

    // Handle abort signal
    const abortHandler = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        reject(new Error('Operation aborted'));
      }
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler);
    }

    operation
      .then((result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          if (signal) {
            signal.removeEventListener('abort', abortHandler);
          }
          resolve(result);
        }
      })
      .catch((error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          if (signal) {
            signal.removeEventListener('abort', abortHandler);
          }
          reject(error);
        }
      });
  });
}

// Re-export strategies
export {
  calculateBackoffDelay,
  constantDelay,
  linearDelay,
  exponentialDelay,
  addJitter,
  parseDuration,
  formatDuration,
  type BackoffStrategy,
} from './strategies';
