/**
 * Retry configuration types.
 * Re-exports from workflow.ts for convenience.
 */

// The RetryConfig is defined in workflow.ts
// Re-export it here for module organization
export type { RetryConfig } from './workflow.js';

/**
 * Backoff strategy type
 */
export type BackoffStrategy = 'constant' | 'linear' | 'exponential';

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
