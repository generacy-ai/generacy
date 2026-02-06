import type { WorkflowRun } from '../types/workflows.js';

/**
 * Polling configuration for workflow run monitoring
 */
export interface PollingConfig {
  /** Polling interval in milliseconds (default: 10000) */
  interval: number;
  /** Maximum number of polling attempts (default: 60) */
  maxAttempts: number;
  /** Callback when run status changes */
  onUpdate?: (run: WorkflowRun) => void;
  /** Callback when run completes (terminal state) */
  onComplete?: (run: WorkflowRun) => void;
  /** Callback when an error occurs during polling */
  onError?: (error: Error) => void;
  /** Callback on each poll (for progress tracking) */
  onPoll?: (attempt: number, maxAttempts: number) => void;
}

/**
 * Result from a polling operation
 */
export interface PollingResult {
  /** Whether the run reached a terminal state */
  completed: boolean;
  /** The final workflow run state */
  run: WorkflowRun;
  /** Number of poll attempts made */
  attempts: number;
  /** Whether polling timed out */
  timedOut: boolean;
}

/**
 * Polling handle for controlling an active polling operation
 */
export interface PollingHandle {
  /** Promise that resolves when polling completes or times out */
  promise: Promise<PollingResult>;
  /** Cancel the polling operation */
  cancel: () => void;
  /** Check if polling is still active */
  isActive: () => boolean;
}

/**
 * Default polling configuration values
 */
export const DEFAULT_POLLING_CONFIG = {
  interval: 10000,
  maxAttempts: 60,
} as const;

/**
 * Create a polling config with defaults applied
 */
export function createPollingConfig(
  options?: Partial<PollingConfig>
): PollingConfig {
  return {
    interval: options?.interval ?? DEFAULT_POLLING_CONFIG.interval,
    maxAttempts: options?.maxAttempts ?? DEFAULT_POLLING_CONFIG.maxAttempts,
    onUpdate: options?.onUpdate,
    onComplete: options?.onComplete,
    onError: options?.onError,
    onPoll: options?.onPoll,
  };
}
