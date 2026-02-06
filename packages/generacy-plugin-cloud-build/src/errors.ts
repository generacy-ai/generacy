/**
 * @generacy-ai/generacy-plugin-cloud-build
 *
 * Custom error classes for the Cloud Build plugin.
 * Implements error classification for retry decisions.
 */

export type CloudBuildErrorCode =
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'RESOURCE_EXHAUSTED'
  | 'FAILED_PRECONDITION'
  | 'UNAVAILABLE'
  | 'INTERNAL'
  | 'DEADLINE_EXCEEDED'
  | 'CANCELLED'
  | 'UNKNOWN';

/**
 * Base error class for all Cloud Build plugin errors.
 */
export class CloudBuildError extends Error {
  readonly code: CloudBuildErrorCode;
  readonly isTransient: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: CloudBuildErrorCode,
    isTransient: boolean,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CloudBuildError';
    this.code = code;
    this.isTransient = isTransient;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Error thrown when authentication fails.
 */
export class AuthError extends CloudBuildError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUTH_FAILED', false, details);
    this.name = 'AuthError';
  }
}

/**
 * Error thrown when a resource is not found.
 */
export class NotFoundError extends CloudBuildError {
  readonly resourceType: string;
  readonly resourceId: string;

  constructor(resourceType: string, resourceId: string) {
    super(
      `${resourceType} not found: ${resourceId}`,
      'NOT_FOUND',
      false,
      { resourceType, resourceId }
    );
    this.name = 'NotFoundError';
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
}

/**
 * Error thrown when rate limited by the API.
 */
export class RateLimitError extends CloudBuildError {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(
      message,
      'RESOURCE_EXHAUSTED',
      true,
      { retryAfterMs }
    );
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Error thrown when an operation times out.
 */
export class TimeoutError extends CloudBuildError {
  readonly timeoutMs: number;
  readonly operation: string;

  constructor(operation: string, timeoutMs: number) {
    super(
      `Operation '${operation}' timed out after ${timeoutMs}ms`,
      'DEADLINE_EXCEEDED',
      true,
      { operation, timeoutMs }
    );
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

/**
 * Error thrown when the service is unavailable.
 */
export class ServiceUnavailableError extends CloudBuildError {
  constructor(message: string) {
    super(message, 'UNAVAILABLE', true);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * Error thrown for invalid arguments.
 */
export class ValidationError extends CloudBuildError {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 'INVALID_ARGUMENT', false, { field });
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * Check if an error is a CloudBuildError.
 */
export function isCloudBuildError(error: unknown): error is CloudBuildError {
  return error instanceof CloudBuildError;
}

/**
 * Check if an error is transient (retryable).
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof CloudBuildError) {
    return error.isTransient;
  }
  return false;
}

/**
 * Map a gRPC/HTTP status code to a CloudBuildErrorCode.
 */
export function mapStatusToErrorCode(status: number): CloudBuildErrorCode {
  switch (status) {
    case 400:
      return 'INVALID_ARGUMENT';
    case 401:
      return 'AUTH_FAILED';
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'ALREADY_EXISTS';
    case 429:
      return 'RESOURCE_EXHAUSTED';
    case 500:
      return 'INTERNAL';
    case 503:
      return 'UNAVAILABLE';
    case 504:
      return 'DEADLINE_EXCEEDED';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Wrap any error as a CloudBuildError.
 */
export function wrapError(error: unknown): CloudBuildError {
  if (error instanceof CloudBuildError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const context = error instanceof Error
    ? { originalError: error.name, stack: error.stack }
    : undefined;

  return new CloudBuildError(message, 'UNKNOWN', false, context);
}
