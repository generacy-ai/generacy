/**
 * Base error class for GitHub Issues plugin
 */
export class GitHubIssuesError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'GitHubIssuesError';
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Authentication failure error
 */
export class GitHubAuthError extends GitHubIssuesError {
  constructor(message = 'GitHub authentication failed', cause?: unknown) {
    super(message, 'AUTH_ERROR', cause);
    this.name = 'GitHubAuthError';
  }
}

/**
 * Rate limit exceeded error
 */
export class GitHubRateLimitError extends GitHubIssuesError {
  constructor(
    message = 'GitHub API rate limit exceeded',
    public readonly resetAt?: Date,
    cause?: unknown
  ) {
    super(message, 'RATE_LIMIT_ERROR', cause);
    this.name = 'GitHubRateLimitError';
  }
}

/**
 * Resource not found error
 */
export class GitHubNotFoundError extends GitHubIssuesError {
  constructor(
    resource: string,
    identifier: string | number,
    cause?: unknown
  ) {
    super(`${resource} '${identifier}' not found`, 'NOT_FOUND_ERROR', cause);
    this.name = 'GitHubNotFoundError';
  }
}

/**
 * Input validation error
 */
export class GitHubValidationError extends GitHubIssuesError {
  constructor(
    message: string,
    public readonly details?: Record<string, string[]>,
    cause?: unknown
  ) {
    super(message, 'VALIDATION_ERROR', cause);
    this.name = 'GitHubValidationError';
  }
}

/**
 * Webhook signature verification error
 */
export class WebhookVerificationError extends GitHubIssuesError {
  constructor(message = 'Invalid webhook signature', cause?: unknown) {
    super(message, 'WEBHOOK_VERIFICATION_ERROR', cause);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * Check if an error is a GitHub API error
 */
export function isGitHubApiError(error: unknown): error is { status: number; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as Record<string, unknown>).status === 'number'
  );
}

/**
 * Convert GitHub API error to plugin error
 */
export function wrapGitHubError(error: unknown, context?: string): GitHubIssuesError {
  if (error instanceof GitHubIssuesError) {
    return error;
  }

  if (isGitHubApiError(error)) {
    const prefix = context ? `${context}: ` : '';

    switch (error.status) {
      case 401:
      case 403:
        return new GitHubAuthError(`${prefix}${error.message}`, error);
      case 404:
        return new GitHubNotFoundError('Resource', context ?? 'unknown', error);
      case 422:
        return new GitHubValidationError(`${prefix}${error.message}`, undefined, error);
      case 429:
        return new GitHubRateLimitError(`${prefix}${error.message}`, undefined, error);
      default:
        return new GitHubIssuesError(`${prefix}${error.message}`, 'API_ERROR', error);
    }
  }

  if (error instanceof Error) {
    return new GitHubIssuesError(error.message, 'UNKNOWN_ERROR', error);
  }

  return new GitHubIssuesError(String(error), 'UNKNOWN_ERROR', error);
}
