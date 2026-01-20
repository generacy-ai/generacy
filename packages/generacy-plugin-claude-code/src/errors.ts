/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Custom error classes for the Claude Code plugin.
 * Implements fail-fast error handling with rich classification.
 */

import type { ErrorCode, SessionStatus, TerminationReason } from './types.js';

/**
 * Base error class for all plugin errors.
 */
export class PluginError extends Error {
  /** Error classification code */
  readonly code: ErrorCode;

  /** Whether this error is transient (retryable) */
  readonly isTransient: boolean;

  /** Additional error context */
  readonly context?: unknown;

  constructor(
    message: string,
    code: ErrorCode,
    isTransient: boolean,
    context?: unknown
  ) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
    this.isTransient = isTransient;
    this.context = context;

    // Maintains proper stack trace for where our error was thrown
    Error.captureStackTrace?.(this, this.constructor);
  }

  /**
   * Convert to InvocationError format for API responses.
   */
  toInvocationError() {
    return {
      code: this.code,
      isTransient: this.isTransient,
      message: this.message,
      context: this.context,
    };
  }
}

/**
 * Error thrown when a session is not found in the session manager.
 */
export class SessionNotFoundError extends PluginError {
  /** The session ID that was not found */
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `Session not found: ${sessionId}`,
      'UNKNOWN',
      false,
      { sessionId }
    );
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

/**
 * Error thrown when an operation is attempted on a session in an invalid state.
 */
export class SessionInvalidStateError extends PluginError {
  /** The session ID */
  readonly sessionId: string;

  /** The current state of the session */
  readonly currentState: SessionStatus;

  /** The expected states for the operation */
  readonly expectedStates: SessionStatus[];

  constructor(
    sessionId: string,
    currentState: SessionStatus,
    expectedStates: SessionStatus[],
    operation: string
  ) {
    super(
      `Cannot ${operation} session ${sessionId}: expected state ${expectedStates.join(' or ')}, but was ${currentState}`,
      'UNKNOWN',
      false,
      { sessionId, currentState, expectedStates, operation }
    );
    this.name = 'SessionInvalidStateError';
    this.sessionId = sessionId;
    this.currentState = currentState;
    this.expectedStates = expectedStates;
  }
}

/**
 * Error thrown when a Docker container fails to start.
 */
export class ContainerStartError extends PluginError {
  /** The Docker image that failed to start */
  readonly image: string;

  /** The underlying Docker error message */
  readonly dockerError?: string;

  constructor(image: string, dockerError?: string) {
    const message = dockerError
      ? `Failed to start container from image ${image}: ${dockerError}`
      : `Failed to start container from image ${image}`;

    super(message, 'CONTAINER_CRASHED', true, { image, dockerError });
    this.name = 'ContainerStartError';
    this.image = image;
    this.dockerError = dockerError;
  }
}

/**
 * Error thrown when an operation requires a running container but it's not running.
 */
export class ContainerNotRunningError extends PluginError {
  /** The session ID */
  readonly sessionId: string;

  /** The container ID (if known) */
  readonly containerId?: string;

  /** The reason the container stopped */
  readonly reason?: TerminationReason;

  constructor(sessionId: string, containerId?: string, reason?: TerminationReason) {
    const message = containerId
      ? `Container ${containerId} for session ${sessionId} is not running`
      : `No running container for session ${sessionId}`;

    super(message, 'CONTAINER_CRASHED', false, { sessionId, containerId, reason });
    this.name = 'ContainerNotRunningError';
    this.sessionId = sessionId;
    this.containerId = containerId;
    this.reason = reason;
  }
}

/**
 * Error thrown when an invocation times out.
 */
export class InvocationTimeoutError extends PluginError {
  /** The session ID */
  readonly sessionId: string;

  /** The invocation ID */
  readonly invocationId: string;

  /** The timeout value in milliseconds */
  readonly timeoutMs: number;

  constructor(sessionId: string, invocationId: string, timeoutMs: number) {
    super(
      `Invocation ${invocationId} timed out after ${timeoutMs}ms`,
      'API_TIMEOUT',
      true,
      { sessionId, invocationId, timeoutMs }
    );
    this.name = 'InvocationTimeoutError';
    this.sessionId = sessionId;
    this.invocationId = invocationId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when an invocation fails with an error from Claude Code.
 */
export class InvocationFailedError extends PluginError {
  /** The session ID */
  readonly sessionId: string;

  /** The invocation ID */
  readonly invocationId: string;

  /** Exit code from the process */
  readonly exitCode: number;

  /** Error output from stderr */
  readonly stderr?: string;

  constructor(
    sessionId: string,
    invocationId: string,
    exitCode: number,
    stderr?: string
  ) {
    const message = stderr
      ? `Invocation ${invocationId} failed with exit code ${exitCode}: ${stderr}`
      : `Invocation ${invocationId} failed with exit code ${exitCode}`;

    // Determine error code based on exit code and stderr content
    let code: ErrorCode = 'UNKNOWN';
    let isTransient = false;

    if (stderr) {
      if (stderr.includes('rate limit') || stderr.includes('429')) {
        code = 'RATE_LIMITED';
        isTransient = true;
      } else if (stderr.includes('auth') || stderr.includes('401') || stderr.includes('403')) {
        code = 'AUTH_FAILED';
        isTransient = false;
      }
    }

    super(message, code, isTransient, { sessionId, invocationId, exitCode, stderr });
    this.name = 'InvocationFailedError';
    this.sessionId = sessionId;
    this.invocationId = invocationId;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Check if an error is a plugin error.
 */
export function isPluginError(error: unknown): error is PluginError {
  return error instanceof PluginError;
}

/**
 * Wrap any error as a PluginError.
 * Preserves PluginError instances, wraps others as UNKNOWN.
 */
export function wrapError(error: unknown): PluginError {
  if (error instanceof PluginError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const context = error instanceof Error ? { originalError: error.name, stack: error.stack } : undefined;

  return new PluginError(message, 'UNKNOWN', false, context);
}
