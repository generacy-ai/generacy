/**
 * Exponential backoff retry utility with jitter.
 */

import type { RetryConfig } from '../types/config.js';
import { DEFAULT_RETRY_CONFIG } from '../types/config.js';

/** Error thrown when max retry attempts exceeded */
export class MaxRetriesExceededError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: Error
  ) {
    super(`Max retries exceeded after ${attempts} attempts: ${lastError.message}`);
    this.name = 'MaxRetriesExceededError';
  }
}

/**
 * Calculates delay for the next retry attempt using exponential backoff with jitter.
 * Formula: min(initialDelay * backoffFactor^attempt + jitter, maxDelay)
 * Jitter is 10% of the calculated delay.
 */
export function calculateRetryDelay(attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): number {
  const baseDelay = config.initialDelay * Math.pow(config.backoffFactor, attempt);
  const jitter = Math.random() * 0.1 * baseDelay;
  return Math.min(baseDelay + jitter, config.maxDelay);
}

/**
 * Calculates delay without jitter (deterministic, useful for testing).
 */
export function calculateRetryDelayDeterministic(attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): number {
  const baseDelay = config.initialDelay * Math.pow(config.backoffFactor, attempt);
  return Math.min(baseDelay, config.maxDelay);
}

/** Sleep for specified milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Options for the retry function */
export interface RetryOptions<T> extends Partial<RetryConfig> {
  /** Function to execute */
  fn: () => Promise<T>;

  /** Optional callback on each retry */
  onRetry?: (attempt: number, error: Error, delay: number) => void;

  /** Optional predicate to determine if error is retryable (default: all errors) */
  isRetryable?: (error: Error) => boolean;
}

/**
 * Executes a function with exponential backoff retry.
 *
 * @param options - Retry options including the function to execute
 * @returns Promise resolving to the function result
 * @throws MaxRetriesExceededError if all retries fail
 */
export async function retry<T>(options: RetryOptions<T>): Promise<T> {
  const config: RetryConfig = {
    maxAttempts: options.maxAttempts ?? DEFAULT_RETRY_CONFIG.maxAttempts,
    initialDelay: options.initialDelay ?? DEFAULT_RETRY_CONFIG.initialDelay,
    maxDelay: options.maxDelay ?? DEFAULT_RETRY_CONFIG.maxDelay,
    backoffFactor: options.backoffFactor ?? DEFAULT_RETRY_CONFIG.backoffFactor,
  };

  const { fn, onRetry, isRetryable = () => true } = options;
  let lastError: Error = new Error('No attempts made');

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryable(lastError)) {
        throw lastError;
      }

      if (attempt < config.maxAttempts - 1) {
        const delay = calculateRetryDelay(attempt, config);
        onRetry?.(attempt, lastError, delay);
        await sleep(delay);
      }
    }
  }

  throw new MaxRetriesExceededError(config.maxAttempts, lastError);
}

/**
 * Creates a retryable version of a function.
 */
export function withRetry<T, Args extends unknown[]>(
  fn: (...args: Args) => Promise<T>,
  config: Partial<RetryConfig> = {}
): (...args: Args) => Promise<T> {
  return (...args: Args) => retry({ fn: () => fn(...args), ...config });
}
