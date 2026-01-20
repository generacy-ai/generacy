import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Header name for request correlation ID
 */
export const CORRELATION_ID_HEADER = 'x-request-id';

/**
 * Augment FastifyRequest to include correlation ID
 */
declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * Generate a new correlation ID
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Extract correlation ID from request headers or generate a new one
 */
export function getCorrelationId(request: FastifyRequest): string {
  const headerValue = request.headers[CORRELATION_ID_HEADER];
  if (typeof headerValue === 'string' && headerValue.length > 0) {
    return headerValue;
  }
  return generateCorrelationId();
}

/**
 * Fastify hook to add correlation ID to requests (async for Fastify v5)
 */
export async function correlationIdHook(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  request.correlationId = getCorrelationId(request);
}

/**
 * Fastify hook to add correlation ID to response headers (async for Fastify v5)
 */
export async function correlationIdResponseHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  reply.header(CORRELATION_ID_HEADER, request.correlationId);
}
