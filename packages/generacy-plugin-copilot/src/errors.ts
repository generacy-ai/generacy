/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Custom error classes for the Copilot plugin.
 */

import type { ErrorCode, WorkspaceStatus } from './types.js';

/**
 * Base error class for all plugin errors.
 */
export class PluginError extends Error {
  readonly code: ErrorCode;
  readonly isTransient: boolean;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: ErrorCode,
    isTransient: boolean,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
    this.isTransient = isTransient;
    this.context = context;

    Error.captureStackTrace?.(this, this.constructor);
  }

  toPluginErrorData() {
    return {
      code: this.code,
      isTransient: this.isTransient,
      message: this.message,
      context: this.context,
    };
  }
}

/**
 * Error thrown when a workspace is not found.
 */
export class WorkspaceNotFoundError extends PluginError {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(
      `Workspace not found: ${workspaceId}`,
      'WORKSPACE_NOT_FOUND',
      false,
      { workspaceId }
    );
    this.name = 'WorkspaceNotFoundError';
    this.workspaceId = workspaceId;
  }
}

/**
 * Error thrown when an operation is attempted on a workspace in an invalid state.
 */
export class WorkspaceInvalidStateError extends PluginError {
  readonly workspaceId: string;
  readonly currentState: WorkspaceStatus;
  readonly expectedStates: WorkspaceStatus[];

  constructor(
    workspaceId: string,
    currentState: WorkspaceStatus,
    expectedStates: WorkspaceStatus[],
    operation: string
  ) {
    super(
      `Cannot ${operation} workspace ${workspaceId}: expected state ${expectedStates.join(' or ')}, but was ${currentState}`,
      'WORKSPACE_INVALID_STATE',
      false,
      { workspaceId, currentState, expectedStates, operation }
    );
    this.name = 'WorkspaceInvalidStateError';
    this.workspaceId = workspaceId;
    this.currentState = currentState;
    this.expectedStates = expectedStates;
  }
}

/**
 * Error thrown when a GitHub API call fails.
 */
export class GitHubAPIError extends PluginError {
  readonly statusCode?: number;
  readonly endpoint?: string;

  constructor(message: string, statusCode?: number, endpoint?: string) {
    const isTransient = statusCode === 429 || (statusCode !== undefined && statusCode >= 500);
    const code: ErrorCode = statusCode === 429 ? 'RATE_LIMITED' :
                            statusCode === 401 || statusCode === 403 ? 'AUTH_FAILED' :
                            'GITHUB_API_ERROR';

    super(message, code, isTransient, { statusCode, endpoint });
    this.name = 'GitHubAPIError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}

/**
 * Error thrown when polling times out.
 */
export class PollingTimeoutError extends PluginError {
  readonly workspaceId: string;
  readonly timeoutMs: number;
  readonly pollCount: number;

  constructor(workspaceId: string, timeoutMs: number, pollCount: number) {
    super(
      `Polling timed out for workspace ${workspaceId} after ${timeoutMs}ms (${pollCount} attempts)`,
      'POLLING_TIMEOUT',
      false,
      { workspaceId, timeoutMs, pollCount }
    );
    this.name = 'PollingTimeoutError';
    this.workspaceId = workspaceId;
    this.timeoutMs = timeoutMs;
    this.pollCount = pollCount;
  }
}

/**
 * Error thrown when a feature is not implemented.
 */
export class NotImplementedError extends PluginError {
  readonly feature: string;

  constructor(feature: string) {
    super(
      `Feature not implemented: ${feature}. Copilot Workspace API is not publicly available.`,
      'NOT_IMPLEMENTED',
      false,
      { feature }
    );
    this.name = 'NotImplementedError';
    this.feature = feature;
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
 */
export function wrapError(error: unknown): PluginError {
  if (error instanceof PluginError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const context = error instanceof Error ? { originalError: error.name, stack: error.stack } : undefined;

  return new PluginError(message, 'UNKNOWN', false, context);
}
