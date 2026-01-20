/**
 * Retry policies for worker job handlers.
 *
 * Different job types have different retry needs:
 * - Agent jobs: Exponential backoff for transient failures
 * - Human jobs: No retry (decisions are one-time)
 * - Integration jobs: Retry on specific HTTP status codes
 */

import type {
  AgentRetryConfig,
  IntegrationRetryConfig,
} from '../types.js';

/**
 * Retry policy interface - all policies implement this
 */
export interface RetryPolicy {
  execute<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Error with a code property for retryable error detection
 */
export interface CodedError extends Error {
  code: string;
}

/**
 * HTTP error with status code for integration retries
 */
export interface HttpError extends Error {
  statusCode: number;
}

/**
 * Exponential backoff retry policy for agent jobs.
 * Retries on specific error codes with exponentially increasing delays.
 */
export class ExponentialBackoffPolicy implements RetryPolicy {
  constructor(private config: AgentRetryConfig) {}

  /**
   * Check if an error is retryable based on its code
   */
  isRetryable(error: unknown): boolean {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof (error as CodedError).code === 'string'
    ) {
      return this.config.retryableErrors.includes((error as CodedError).code);
    }
    return false;
  }

  /**
   * Calculate delay for a given attempt using exponential backoff
   */
  private calculateDelay(attempt: number): number {
    const delay =
      this.config.initialDelay *
      Math.pow(this.config.backoffMultiplier, attempt);
    return Math.min(delay, this.config.maxDelay);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryable(error) || attempt >= this.config.maxRetries) {
          throw lastError;
        }

        const delay = this.calculateDelay(attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}

/**
 * No-retry policy - executes the function once without any retry logic.
 * Used for human jobs where decisions should not be retried.
 */
export class NoRetryPolicy implements RetryPolicy {
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/**
 * Status code based retry policy for integration jobs.
 * Retries on specific HTTP status codes with fixed delay.
 */
export class StatusCodeRetryPolicy implements RetryPolicy {
  constructor(private config: IntegrationRetryConfig) {}

  /**
   * Check if an error should trigger a retry based on status code
   */
  isRetryable(error: unknown): boolean {
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof (error as HttpError).statusCode === 'number'
    ) {
      return this.config.retryOn.includes((error as HttpError).statusCode);
    }
    return false;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryable(error) || attempt >= this.config.maxRetries) {
          throw lastError;
        }

        await new Promise(resolve =>
          setTimeout(resolve, this.config.retryDelay)
        );
      }
    }

    throw lastError;
  }
}
