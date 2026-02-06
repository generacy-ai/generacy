import type { Transition } from '../types/workflows.js';

/**
 * Base error class for Jira plugin
 */
export class JiraPluginError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'JiraPluginError';
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Authentication failure error
 */
export class JiraAuthError extends JiraPluginError {
  constructor(message = 'Jira authentication failed', cause?: unknown) {
    super(message, 'AUTH_ERROR', cause);
    this.name = 'JiraAuthError';
  }
}

/**
 * Rate limit exceeded error
 */
export class JiraRateLimitError extends JiraPluginError {
  constructor(
    message = 'Jira API rate limit exceeded',
    public readonly resetAt?: Date,
    cause?: unknown
  ) {
    super(message, 'RATE_LIMIT_ERROR', cause);
    this.name = 'JiraRateLimitError';
  }
}

/**
 * Resource not found error
 */
export class JiraNotFoundError extends JiraPluginError {
  constructor(
    resource: string,
    identifier: string | number,
    cause?: unknown
  ) {
    super(`${resource} '${identifier}' not found`, 'NOT_FOUND_ERROR', cause);
    this.name = 'JiraNotFoundError';
  }
}

/**
 * Input validation error
 */
export class JiraValidationError extends JiraPluginError {
  constructor(
    message: string,
    public readonly details?: Record<string, string[]>,
    cause?: unknown
  ) {
    super(message, 'VALIDATION_ERROR', cause);
    this.name = 'JiraValidationError';
  }
}

/**
 * Workflow transition error
 */
export class JiraTransitionError extends JiraPluginError {
  constructor(
    message: string,
    public readonly availableTransitions?: Transition[],
    cause?: unknown
  ) {
    super(message, 'TRANSITION_ERROR', cause);
    this.name = 'JiraTransitionError';
  }
}

/**
 * Connection/network error
 */
export class JiraConnectionError extends JiraPluginError {
  constructor(message = 'Failed to connect to Jira', cause?: unknown) {
    super(message, 'CONNECTION_ERROR', cause);
    this.name = 'JiraConnectionError';
  }
}

/**
 * Check if an error is a Jira API error
 */
export function isJiraApiError(error: unknown): error is { status: number; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as Record<string, unknown>).status === 'number'
  );
}

/**
 * Convert Jira API error to plugin error
 */
export function wrapJiraError(error: unknown, context?: string): JiraPluginError {
  if (error instanceof JiraPluginError) {
    return error;
  }

  const prefix = context ? `${context}: ` : '';

  if (isJiraApiError(error)) {
    switch (error.status) {
      case 401:
        return new JiraAuthError(`${prefix}${error.message}`, error);
      case 403:
        return new JiraAuthError(`${prefix}Forbidden - ${error.message}`, error);
      case 404:
        return new JiraNotFoundError('Resource', context ?? 'unknown', error);
      case 422:
        return new JiraValidationError(`${prefix}${error.message}`, undefined, error);
      case 429:
        return new JiraRateLimitError(`${prefix}${error.message}`, undefined, error);
      default:
        return new JiraPluginError(`${prefix}${error.message}`, 'API_ERROR', error);
    }
  }

  if (error instanceof Error) {
    // Check for connection errors
    if (error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
      return new JiraConnectionError(`${prefix}${error.message}`, error);
    }
    return new JiraPluginError(`${prefix}${error.message}`, 'UNKNOWN_ERROR', error);
  }

  return new JiraPluginError(`${prefix}${String(error)}`, 'UNKNOWN_ERROR', error);
}
