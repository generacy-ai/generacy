import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RateLimitConfig } from '../config/index.js';
import { API_KEY_HEADER } from '../auth/api-key.js';

/**
 * Rate limit key generator options
 */
export interface RateLimitKeyOptions {
  /** Use API key for rate limiting (default: true) */
  useApiKey?: boolean;
  /** Fallback to IP if no API key (default: true) */
  fallbackToIp?: boolean;
}

/**
 * Generate rate limit key from request
 */
export function generateRateLimitKey(
  request: FastifyRequest,
  options: RateLimitKeyOptions = {}
): string {
  const { useApiKey = true, fallbackToIp = true } = options;

  // Try API key first
  if (useApiKey) {
    const apiKey = request.headers[API_KEY_HEADER];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      // Use first 8 chars of API key as identifier (avoid exposing full key)
      return `apikey:${apiKey.substring(0, 8)}`;
    }
  }

  // Try authenticated user
  if (request.auth?.userId) {
    return `user:${request.auth.userId}`;
  }

  // Fallback to IP
  if (fallbackToIp) {
    const ip = request.ip || request.headers['x-forwarded-for'] || 'unknown';
    return `ip:${Array.isArray(ip) ? ip[0] : ip}`;
  }

  return 'anonymous';
}

/**
 * Parse time window string to milliseconds
 */
export function parseTimeWindow(timeWindow: string): number {
  const match = timeWindow.match(/^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hour|hours)$/i);
  if (!match || !match[1] || !match[2]) {
    // Default to 1 minute
    return 60 * 1000;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's':
    case 'sec':
    case 'second':
    case 'seconds':
      return value * 1000;
    case 'm':
    case 'min':
    case 'minute':
    case 'minutes':
      return value * 60 * 1000;
    case 'h':
    case 'hour':
    case 'hours':
      return value * 60 * 60 * 1000;
    default:
      return 60 * 1000;
  }
}

/**
 * Setup rate limiting middleware
 */
export async function setupRateLimit(
  server: FastifyInstance,
  config: RateLimitConfig
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  const rateLimit = await import('@fastify/rate-limit');

  await server.register(rateLimit.default, {
    max: config.max,
    timeWindow: parseTimeWindow(config.timeWindow),
    keyGenerator: (request: FastifyRequest) => generateRateLimitKey(request),
    errorResponseBuilder: (request: FastifyRequest, context) => {
      return {
        type: 'urn:generacy:error:rate-limited',
        title: 'Rate Limit Exceeded',
        status: 429,
        detail: `You have exceeded the rate limit of ${context.max} requests per ${config.timeWindow}`,
        instance: request.url,
        traceId: request.correlationId,
        retryAfter: Math.ceil(context.ttl / 1000),
      };
    },
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });
}

/**
 * Rate limit info for a key
 */
export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp
}
