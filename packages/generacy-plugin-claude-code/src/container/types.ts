/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Internal types for container management.
 */

import type { ContainerConfig } from '../types.js';

/**
 * Internal state of a managed container.
 */
export type ContainerState =
  | { status: 'creating' }
  | { status: 'created'; containerId: string }
  | { status: 'starting'; containerId: string }
  | { status: 'running'; containerId: string; startedAt: Date }
  | { status: 'stopping'; containerId: string }
  | { status: 'stopped'; containerId: string; stoppedAt: Date; exitCode?: number }
  | { status: 'error'; containerId?: string; error: string };

/**
 * Health check configuration for containers.
 */
export interface HealthCheckConfig {
  /** Command to run for health check */
  cmd: string[];

  /** Interval between health checks in milliseconds */
  intervalMs: number;

  /** Timeout for each health check in milliseconds */
  timeoutMs: number;

  /** Number of consecutive failures before unhealthy */
  retries: number;

  /** Initial delay before first health check in milliseconds */
  startPeriodMs: number;
}

/**
 * Health status of a container.
 */
export type HealthStatus =
  | 'unknown'
  | 'starting'
  | 'healthy'
  | 'unhealthy';

/**
 * Result of a health check.
 */
export interface HealthCheckResult {
  status: HealthStatus;
  lastCheck?: Date;
  failureCount: number;
  lastError?: string;
}

/**
 * Internal representation of a managed container.
 */
export interface ManagedContainer {
  /** Docker container ID */
  containerId: string;

  /** Session ID this container belongs to */
  sessionId: string;

  /** Container configuration */
  config: ContainerConfig;

  /** Current state */
  state: ContainerState;

  /** Health status */
  health: HealthCheckResult;

  /** When the container was created */
  createdAt: Date;

  /** Attached streams (if any) */
  streams?: ContainerStreams;
}

/**
 * Attached I/O streams for a container.
 */
export interface ContainerStreams {
  /** Stdin stream for writing to container */
  stdin: NodeJS.WritableStream;

  /** Stdout stream for reading output */
  stdout: NodeJS.ReadableStream;

  /** Stderr stream for reading errors */
  stderr: NodeJS.ReadableStream;
}

/**
 * Options for creating a container.
 */
export interface CreateContainerOptions {
  /** Session ID for this container */
  sessionId: string;

  /** Container configuration */
  config: ContainerConfig;

  /** Optional health check configuration */
  healthCheck?: HealthCheckConfig;
}

/**
 * Options for starting a container.
 */
export interface StartContainerOptions {
  /** Whether to wait for container to be healthy before returning */
  waitForHealthy?: boolean;

  /** Timeout in milliseconds for waiting */
  timeoutMs?: number;
}

/**
 * Options for stopping a container.
 */
export interface StopContainerOptions {
  /** Timeout in seconds before force kill */
  timeoutSeconds?: number;

  /** Whether to remove the container after stopping */
  remove?: boolean;
}

/**
 * Options for attaching to a container.
 */
export interface AttachOptions {
  /** Attach stdin */
  stdin?: boolean;

  /** Attach stdout */
  stdout?: boolean;

  /** Attach stderr */
  stderr?: boolean;

  /** Hijack the connection for bidirectional I/O */
  hijack?: boolean;

  /** Keep the stream open */
  stream?: boolean;
}

/**
 * Result of executing a command in a container.
 */
export interface ExecResult {
  /** Exit code from the command */
  exitCode: number;

  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;
}

/**
 * Default health check configuration.
 */
export const DEFAULT_HEALTH_CHECK: HealthCheckConfig = {
  cmd: ['echo', 'healthy'],
  intervalMs: 30000,
  timeoutMs: 5000,
  retries: 3,
  startPeriodMs: 10000,
};

/**
 * Default container timeout in milliseconds (5 minutes).
 */
export const DEFAULT_CONTAINER_TIMEOUT_MS = 300000;

/**
 * Default stop timeout in seconds.
 */
export const DEFAULT_STOP_TIMEOUT_SECONDS = 10;
