/**
 * Retry backoff strategy calculation functions.
 * Provides constant, linear, and exponential backoff algorithms.
 */

/**
 * Backoff strategy type
 */
export type BackoffStrategy = 'constant' | 'linear' | 'exponential';

/**
 * Calculate constant backoff delay
 * Returns the same delay for every attempt.
 *
 * @param _attempt Current attempt number (1-indexed)
 * @param baseDelay Base delay in milliseconds
 * @param maxDelay Maximum delay cap in milliseconds
 * @returns Delay in milliseconds
 */
export function constantDelay(
  _attempt: number,
  baseDelay: number,
  maxDelay?: number
): number {
  const delay = baseDelay;
  return maxDelay !== undefined ? Math.min(delay, maxDelay) : delay;
}

/**
 * Calculate linear backoff delay
 * Delay increases linearly with each attempt: delay = baseDelay * attempt
 *
 * @param attempt Current attempt number (1-indexed)
 * @param baseDelay Base delay in milliseconds
 * @param maxDelay Maximum delay cap in milliseconds
 * @returns Delay in milliseconds
 */
export function linearDelay(
  attempt: number,
  baseDelay: number,
  maxDelay?: number
): number {
  const delay = baseDelay * attempt;
  return maxDelay !== undefined ? Math.min(delay, maxDelay) : delay;
}

/**
 * Calculate exponential backoff delay
 * Delay doubles with each attempt: delay = baseDelay * 2^(attempt-1)
 *
 * @param attempt Current attempt number (1-indexed)
 * @param baseDelay Base delay in milliseconds
 * @param maxDelay Maximum delay cap in milliseconds
 * @returns Delay in milliseconds
 */
export function exponentialDelay(
  attempt: number,
  baseDelay: number,
  maxDelay?: number
): number {
  const delay = baseDelay * Math.pow(2, attempt - 1);
  return maxDelay !== undefined ? Math.min(delay, maxDelay) : delay;
}

/**
 * Add jitter to a delay value
 * Jitter helps prevent thundering herd problems.
 *
 * @param delay Base delay in milliseconds
 * @param jitterFactor Jitter factor (0-1), default 0.1 (10%)
 * @returns Delay with jitter applied
 */
export function addJitter(delay: number, jitterFactor = 0.1): number {
  const jitterAmount = delay * jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterAmount; // -jitter to +jitter
  return Math.max(0, Math.round(delay + jitter));
}

/**
 * Calculate backoff delay based on strategy
 *
 * @param strategy Backoff strategy
 * @param attempt Current attempt number (1-indexed)
 * @param baseDelay Base delay in milliseconds
 * @param maxDelay Maximum delay cap in milliseconds
 * @param jitterFactor Optional jitter factor (0-1)
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  strategy: BackoffStrategy,
  attempt: number,
  baseDelay: number,
  maxDelay?: number,
  jitterFactor?: number
): number {
  let delay: number;

  switch (strategy) {
    case 'constant':
      delay = constantDelay(attempt, baseDelay, maxDelay);
      break;
    case 'linear':
      delay = linearDelay(attempt, baseDelay, maxDelay);
      break;
    case 'exponential':
      delay = exponentialDelay(attempt, baseDelay, maxDelay);
      break;
    default:
      delay = baseDelay;
  }

  if (jitterFactor !== undefined && jitterFactor > 0) {
    delay = addJitter(delay, jitterFactor);
  }

  return delay;
}

/**
 * Parse a duration string to milliseconds
 * Supports: '10s', '5m', '1h', '1000ms', '1000'
 *
 * @param duration Duration string or number
 * @returns Duration in milliseconds
 */
export function parseDuration(duration: string | number): number {
  if (typeof duration === 'number') {
    return duration;
  }

  const match = duration.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const [, value, unit] = match;
  const numValue = parseFloat(value!);

  switch (unit?.toLowerCase()) {
    case 'h':
      return numValue * 60 * 60 * 1000;
    case 'm':
      return numValue * 60 * 1000;
    case 's':
      return numValue * 1000;
    case 'ms':
    case undefined:
      return numValue;
    default:
      return numValue;
  }
}

/**
 * Format milliseconds as a human-readable duration
 *
 * @param ms Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 3600000) {
    return `${(ms / 60000).toFixed(1)}m`;
  }
  return `${(ms / 3600000).toFixed(1)}h`;
}
