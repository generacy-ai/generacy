/**
 * Base error class for GitHub Actions plugin errors
 */
export class GitHubActionsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'GitHubActionsError';
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Error thrown when GitHub API rate limit is exceeded
 */
export class RateLimitError extends GitHubActionsError {
  constructor(
    public readonly resetAt: Date,
    cause?: Error
  ) {
    const resetTime = resetAt.toISOString();
    super(
      `GitHub API rate limit exceeded. Resets at ${resetTime}`,
      'RATE_LIMIT_EXCEEDED',
      cause
    );
    this.name = 'RateLimitError';
  }

  /**
   * Get milliseconds until rate limit resets
   */
  getTimeUntilReset(): number {
    return Math.max(0, this.resetAt.getTime() - Date.now());
  }
}

/**
 * Error thrown when a workflow is not found
 */
export class WorkflowNotFoundError extends GitHubActionsError {
  constructor(
    public readonly workflow: string,
    cause?: Error
  ) {
    super(`Workflow not found: ${workflow}`, 'WORKFLOW_NOT_FOUND', cause);
    this.name = 'WorkflowNotFoundError';
  }
}

/**
 * Error thrown when a workflow run is not found
 */
export class RunNotFoundError extends GitHubActionsError {
  constructor(
    public readonly runId: number,
    cause?: Error
  ) {
    super(`Workflow run not found: ${runId}`, 'RUN_NOT_FOUND', cause);
    this.name = 'RunNotFoundError';
  }
}

/**
 * Error thrown when a job is not found
 */
export class JobNotFoundError extends GitHubActionsError {
  constructor(
    public readonly jobId: number,
    cause?: Error
  ) {
    super(`Job not found: ${jobId}`, 'JOB_NOT_FOUND', cause);
    this.name = 'JobNotFoundError';
  }
}

/**
 * Error thrown when an artifact is not found
 */
export class ArtifactNotFoundError extends GitHubActionsError {
  constructor(
    public readonly artifactId: number,
    cause?: Error
  ) {
    super(`Artifact not found: ${artifactId}`, 'ARTIFACT_NOT_FOUND', cause);
    this.name = 'ArtifactNotFoundError';
  }
}

/**
 * Error thrown when a check run is not found
 */
export class CheckRunNotFoundError extends GitHubActionsError {
  constructor(
    public readonly checkRunId: number,
    cause?: Error
  ) {
    super(`Check run not found: ${checkRunId}`, 'CHECK_RUN_NOT_FOUND', cause);
    this.name = 'CheckRunNotFoundError';
  }
}

/**
 * Error thrown when polling times out
 */
export class PollingTimeoutError extends GitHubActionsError {
  constructor(
    public readonly runId: number,
    public readonly maxAttempts: number,
    cause?: Error
  ) {
    super(
      `Polling timed out for run ${runId} after ${maxAttempts} attempts`,
      'POLLING_TIMEOUT',
      cause
    );
    this.name = 'PollingTimeoutError';
  }
}

/**
 * Error thrown for invalid configuration
 */
export class ConfigurationError extends GitHubActionsError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIGURATION_ERROR', cause);
    this.name = 'ConfigurationError';
  }
}

/**
 * Check if an error is a GitHub API rate limit error
 */
export function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError;
}

/**
 * Check if an error is a GitHub Actions plugin error
 */
export function isGitHubActionsError(
  error: unknown
): error is GitHubActionsError {
  return error instanceof GitHubActionsError;
}
