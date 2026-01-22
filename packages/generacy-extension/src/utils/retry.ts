/**
 * Retry utilities with exponential backoff
 */

/**
 * Configuration for retry logic
 */
export interface RetryConfig {
  /** Maximum retry attempts */
  maxAttempts: number;

  /** Initial delay in milliseconds */
  initialDelay: number;

  /** Maximum delay in milliseconds */
  maxDelay: number;

  /** Backoff multiplier */
  backoffMultiplier: number;

  /** Whether to add jitter */
  addJitter: boolean;

  /** Jitter factor (0-1) */
  jitterFactor?: number;

  /** Retry predicate - return true to retry */
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * Default retry configurations for different scenarios
 */
export const RETRY_CONFIGS: Record<string, RetryConfig> = {
  api: {
    maxAttempts: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    addJitter: true,
    jitterFactor: 0.25,
  },
  fileSystem: {
    maxAttempts: 3,
    initialDelay: 500,
    maxDelay: 5000,
    backoffMultiplier: 2,
    addJitter: false,
  },
  validation: {
    maxAttempts: 1, // No retry for validation errors
    initialDelay: 0,
    maxDelay: 0,
    backoffMultiplier: 1,
    addJitter: false,
  },
};

/**
 * Retry statistics
 */
export interface RetryStatistics {
  /** Total attempts made */
  attempts: number;

  /** Total delay time (ms) */
  totalDelay: number;

  /** Whether operation succeeded */
  succeeded: boolean;

  /** Final error (if failed) */
  error?: Error;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and optional jitter
 */
function calculateDelay(
  attempt: number,
  config: RetryConfig
): number {
  // Exponential backoff
  const exponentialDelay = Math.min(
    config.initialDelay * Math.pow(config.backoffMultiplier, attempt - 1),
    config.maxDelay
  );

  // Add jitter if enabled
  if (config.addJitter) {
    const jitterFactor = config.jitterFactor ?? 0.25;
    const jitterRange = exponentialDelay * jitterFactor;
    const jitter = (Math.random() - 0.5) * 2 * jitterRange;
    return Math.max(0, exponentialDelay + jitter);
  }

  return exponentialDelay;
}

/**
 * Execute a function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const fullConfig: RetryConfig = {
    ...RETRY_CONFIGS.api,
    ...config,
  };

  const stats: RetryStatistics = {
    attempts: 0,
    totalDelay: 0,
    succeeded: false,
  };

  let lastError: Error;

  for (let attempt = 1; attempt <= fullConfig.maxAttempts; attempt++) {
    stats.attempts = attempt;

    try {
      const result = await fn();
      stats.succeeded = true;
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const shouldRetry =
        fullConfig.shouldRetry?.(lastError, attempt) ??
        attempt < fullConfig.maxAttempts;

      if (!shouldRetry) {
        stats.error = lastError;
        throw lastError;
      }

      // Calculate and apply delay before next attempt
      if (attempt < fullConfig.maxAttempts) {
        const delay = calculateDelay(attempt, fullConfig);
        stats.totalDelay += delay;
        await sleep(delay);
      }
    }
  }

  // If we get here, all attempts failed
  stats.error = lastError!;
  throw lastError!;
}

/**
 * Create a retry wrapper for a function
 */
export function retryable<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  config: Partial<RetryConfig> = {}
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs) => {
    return withRetry(() => fn(...args), config);
  };
}

/**
 * Determine if an error is retryable (transient)
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Network errors
  if (
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ETIMEDOUT') ||
    error.message.includes('ENOTFOUND') ||
    error.message.includes('network') ||
    error.message.includes('timeout')
  ) {
    return true;
  }

  // HTTP errors (if applicable)
  if ('status' in error) {
    const status = (error as { status?: number }).status;
    // Retry on 5xx and specific 4xx errors
    if (
      status &&
      (status >= 500 || status === 408 || status === 429 || status === 503)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Create a retry config with custom shouldRetry predicate for retryable errors
 */
export function createRetryableConfig(
  baseConfig: Partial<RetryConfig> = {}
): RetryConfig {
  return {
    ...RETRY_CONFIGS.api,
    ...baseConfig,
    shouldRetry: (error, attempt) => {
      if (attempt >= (baseConfig.maxAttempts ?? RETRY_CONFIGS.api.maxAttempts)) {
        return false;
      }
      return isRetryableError(error);
    },
  };
}
