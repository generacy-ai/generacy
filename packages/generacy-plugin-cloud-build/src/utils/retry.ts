/**
 * Retry utility with exponential backoff and jitter.
 *
 * Parameters:
 * - Initial delay: 1000ms
 * - Max delay: 30000ms
 * - Max attempts: 3
 * - Jitter: ±20%
 *
 * Formula: delay = min(maxDelay, initialDelay * 2^attempt) * (0.8 + random() * 0.4)
 */

import type { RetryConfig } from '../config/types.js';
import { isTransientError, CloudBuildError } from '../errors.js';

export interface RetryOptions extends RetryConfig {
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  shouldRetry: isTransientError,
  onRetry: () => {},
};

/**
 * Calculate delay with exponential backoff and jitter.
 */
export function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number
): number {
  // Exponential backoff: initialDelay * 2^attempt
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt);

  // Cap at maxDelay
  const cappedDelay = Math.min(maxDelayMs, exponentialDelay);

  // Add jitter: ±20% (multiply by 0.8 to 1.2)
  const jitter = 0.8 + Math.random() * 0.4;

  return Math.round(cappedDelay * jitter);
}

/**
 * Sleep for a specified duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const config: Required<RetryOptions> = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (!config.shouldRetry(error)) {
        throw error;
      }

      // Check if we have more attempts left
      if (attempt + 1 >= config.maxAttempts) {
        throw error;
      }

      // Calculate delay and wait
      const delayMs = calculateDelay(attempt, config.initialDelayMs, config.maxDelayMs);
      config.onRetry(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

/**
 * Create a retry wrapper with pre-configured options.
 */
export function createRetryWrapper(config: RetryConfig): <T>(fn: () => Promise<T>) => Promise<T> {
  return <T>(fn: () => Promise<T>) => withRetry(fn, config);
}

/**
 * Check if an error is retryable based on HTTP/gRPC status codes.
 */
export function isRetryableStatusCode(statusCode: number): boolean {
  // Retryable HTTP status codes
  const retryableCodes = [
    408, // Request Timeout
    429, // Too Many Requests
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable
    504, // Gateway Timeout
  ];

  return retryableCodes.includes(statusCode);
}

/**
 * Enhanced retry check that considers both CloudBuildError and status codes.
 */
export function shouldRetryError(error: unknown): boolean {
  if (error instanceof CloudBuildError) {
    return error.isTransient;
  }

  // Check for status code in error object
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: number }).code;
    if (typeof code === 'number') {
      return isRetryableStatusCode(code);
    }
  }

  return false;
}
