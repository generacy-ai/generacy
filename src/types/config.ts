/**
 * Configuration types for the message router.
 */

/** Redis connection configuration */
export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

/** Retry policy configuration */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 5) */
  maxAttempts: number;

  /** Initial delay in milliseconds (default: 1000) */
  initialDelay: number;

  /** Maximum delay in milliseconds (default: 16000) */
  maxDelay: number;

  /** Backoff multiplier (default: 2) */
  backoffFactor: number;
}

/** Main router configuration */
export interface RouterConfig {
  /** Redis configuration */
  redis: RedisConfig;

  /** Default message TTL in milliseconds (default: 3600000 = 1 hour) */
  defaultTtl: number;

  /** Retry policy configuration */
  retry: RetryConfig;
}

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  initialDelay: 1000,
  maxDelay: 16000,
  backoffFactor: 2,
};

/** Default Redis configuration */
export const DEFAULT_REDIS_CONFIG: RedisConfig = {
  host: 'localhost',
  port: 6379,
};

/** Creates a complete router config with defaults */
export function createRouterConfig(
  partial: Partial<RouterConfig> & { redis?: Partial<RedisConfig> }
): RouterConfig {
  return {
    redis: {
      ...DEFAULT_REDIS_CONFIG,
      ...partial.redis,
    },
    defaultTtl: partial.defaultTtl ?? 3600000,
    retry: {
      ...DEFAULT_RETRY_CONFIG,
      ...partial.retry,
    },
  };
}
