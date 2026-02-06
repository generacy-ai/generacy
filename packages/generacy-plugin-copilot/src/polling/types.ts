/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Polling infrastructure type definitions.
 */

import type { WorkspaceStatus } from '../types.js';

/**
 * Polling configuration with defaults.
 */
export interface PollingConfig {
  /** Initial polling interval in milliseconds */
  initialIntervalMs: number;
  /** Maximum polling interval in milliseconds */
  maxIntervalMs: number;
  /** Backoff multiplier for interval growth */
  backoffMultiplier: number;
  /** Maximum number of poll attempts */
  maxRetries: number;
  /** Timeout for the entire polling operation (ms) */
  timeoutMs?: number;
}

/**
 * Default polling configuration values.
 */
export const DEFAULT_POLLING_CONFIG: PollingConfig = {
  initialIntervalMs: 5000,
  maxIntervalMs: 60000,
  backoffMultiplier: 1.5,
  maxRetries: 100,
  timeoutMs: 3600000, // 1 hour
};

/**
 * Internal polling state.
 */
export interface PollState {
  /** Last poll timestamp */
  lastPolledAt?: Date;
  /** Number of poll attempts */
  pollCount: number;
  /** Current interval in ms */
  currentIntervalMs: number;
  /** Polling start time */
  startedAt: Date;
  /** Whether polling is active */
  isActive: boolean;
}

/**
 * Status check function type.
 */
export type StatusChecker = () => Promise<WorkspaceStatus>;

/**
 * Status callback for streaming.
 */
export type StatusCallback = (status: WorkspaceStatus, previousStatus: WorkspaceStatus) => void;

/**
 * Polling result.
 */
export interface PollResult {
  /** Final status */
  status: WorkspaceStatus;
  /** Whether a terminal state was reached */
  isTerminal: boolean;
  /** Total poll count */
  pollCount: number;
  /** Duration in ms */
  durationMs: number;
}
