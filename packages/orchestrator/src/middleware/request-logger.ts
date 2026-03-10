import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';

/**
 * Request start time symbol
 */
const REQUEST_START_TIME = Symbol('requestStartTime');

/** Paths excluded from request logging (health probes, metrics) */
const SILENT_PATHS = new Set(['/health', '/health/live', '/health/ready', '/metrics']);

/**
 * Augment FastifyRequest with start time
 */
declare module 'fastify' {
  interface FastifyRequest {
    [REQUEST_START_TIME]?: bigint;
  }
}

/**
 * Log request start
 */
export function requestStartHook(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  request[REQUEST_START_TIME] = process.hrtime.bigint();

  if (!SILENT_PATHS.has(request.url)) {
    request.log.info({
      correlationId: request.correlationId,
      method: request.method,
      url: request.url,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    }, 'Request started');
  }

  done();
}

/**
 * Log request completion
 */
export function requestEndHook(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  const startTime = request[REQUEST_START_TIME];
  let durationMs = 0;

  if (startTime) {
    const endTime = process.hrtime.bigint();
    durationMs = Number(endTime - startTime) / 1_000_000;
  }

  const logData = {
    correlationId: request.correlationId,
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    durationMs: Math.round(durationMs * 100) / 100,
    userId: request.auth?.userId,
  };

  if (SILENT_PATHS.has(request.url)) {
    // Only log health/metrics requests if they fail
    if (reply.statusCode >= 500) {
      request.log.error(logData, 'Health check failed');
    }
  } else if (reply.statusCode >= 500) {
    request.log.error(logData, 'Request completed with server error');
  } else if (reply.statusCode >= 400) {
    request.log.warn(logData, 'Request completed with client error');
  } else {
    request.log.info(logData, 'Request completed');
  }

  done();
}

/**
 * Log request errors
 */
export function requestErrorHook(
  request: FastifyRequest,
  _reply: FastifyReply,
  error: Error,
  done: HookHandlerDoneFunction
): void {
  const startTime = request[REQUEST_START_TIME];
  let durationMs = 0;

  if (startTime) {
    const endTime = process.hrtime.bigint();
    durationMs = Number(endTime - startTime) / 1_000_000;
  }

  request.log.error({
    correlationId: request.correlationId,
    method: request.method,
    url: request.url,
    durationMs: Math.round(durationMs * 100) / 100,
    error: {
      message: error.message,
      name: error.name,
      stack: error.stack,
    },
  }, 'Request error');

  done();
}

/**
 * Sanitize URL for logging (remove sensitive query params)
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost');
    const sensitiveParams = ['token', 'api_key', 'apikey', 'secret', 'password', 'code'];

    for (const param of sensitiveParams) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]');
      }
    }

    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
