import type { FastifyInstance, FastifyError, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  type ProblemDetails,
  type ValidationError,
  type ErrorType,
  ErrorTypes,
  createProblemDetails,
} from '../types/index.js';

/**
 * Convert Zod error to validation errors
 */
function zodErrorToValidationErrors(error: ZodError): ValidationError[] {
  return error.errors.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Check if error is a Fastify validation error
 */
function isFastifyValidationError(error: FastifyError): boolean {
  return error.code === 'FST_ERR_VALIDATION' || error.validation !== undefined;
}

/**
 * Convert Fastify validation error to validation errors
 */
function fastifyValidationToErrors(error: FastifyError): ValidationError[] {
  if (!error.validation) {
    return [];
  }

  return error.validation.map((v) => ({
    field: v.instancePath?.replace(/^\//, '').replace(/\//g, '.') || (v.params as Record<string, string>)?.missingProperty || 'unknown',
    message: v.message || 'Validation failed',
    code: v.keyword || 'validation',
  }));
}

/**
 * Create error response from various error types
 */
export function createErrorResponse(
  error: Error | FastifyError,
  request: FastifyRequest
): ProblemDetails {
  // Zod validation error
  if (error instanceof ZodError) {
    return createProblemDetails(ErrorTypes.VALIDATION_ERROR, 'Validation Error', 400, {
      detail: 'Request validation failed',
      instance: request.url,
      traceId: request.correlationId,
      errors: zodErrorToValidationErrors(error),
    });
  }

  // Fastify validation error
  if ('code' in error && isFastifyValidationError(error as FastifyError)) {
    return createProblemDetails(ErrorTypes.VALIDATION_ERROR, 'Validation Error', 400, {
      detail: error.message,
      instance: request.url,
      traceId: request.correlationId,
      errors: fastifyValidationToErrors(error as FastifyError),
    });
  }

  // Fastify error with status code
  if ('statusCode' in error) {
    const statusCode = (error as FastifyError).statusCode || 500;
    const errorType = getErrorTypeForStatus(statusCode) as ErrorType;

    return createProblemDetails(errorType, getErrorTitle(statusCode), statusCode, {
      detail: error.message,
      instance: request.url,
      traceId: request.correlationId,
    });
  }

  // Generic error
  return createProblemDetails(ErrorTypes.INTERNAL, 'Internal Server Error', 500, {
    detail: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : error.message,
    instance: request.url,
    traceId: request.correlationId,
  });
}

/**
 * Get error type URI for HTTP status code
 */
function getErrorTypeForStatus(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return ErrorTypes.VALIDATION_ERROR;
    case 401:
      return ErrorTypes.UNAUTHORIZED;
    case 403:
      return ErrorTypes.FORBIDDEN;
    case 404:
      return ErrorTypes.NOT_FOUND;
    case 409:
      return ErrorTypes.CONFLICT;
    case 429:
      return ErrorTypes.RATE_LIMITED;
    case 503:
      return ErrorTypes.SERVICE_UNAVAILABLE;
    default:
      return ErrorTypes.INTERNAL;
  }
}

/**
 * Get error title for HTTP status code
 */
function getErrorTitle(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 409:
      return 'Conflict';
    case 429:
      return 'Too Many Requests';
    case 503:
      return 'Service Unavailable';
    default:
      return 'Internal Server Error';
  }
}

/**
 * Setup global error handler
 */
export function setupErrorHandler(server: FastifyInstance): void {
  server.setErrorHandler((error: Error | FastifyError, request, reply) => {
    const problemDetails = createErrorResponse(error, request);

    // Log the error
    if (problemDetails.status >= 500) {
      request.log.error({ err: error, problemDetails }, 'Server error');
    } else if (problemDetails.status >= 400) {
      request.log.warn({ err: error, problemDetails }, 'Client error');
    }

    // Send RFC 7807 response
    return reply
      .status(problemDetails.status)
      .header('content-type', 'application/problem+json')
      .send(problemDetails);
  });

  // Handle 404 Not Found
  server.setNotFoundHandler((request, reply) => {
    const problemDetails = createProblemDetails(ErrorTypes.NOT_FOUND, 'Not Found', 404, {
      detail: `Route ${request.method} ${request.url} not found`,
      instance: request.url,
      traceId: request.correlationId,
    });

    return reply
      .status(404)
      .header('content-type', 'application/problem+json')
      .send(problemDetails);
  });
}

/**
 * Create a typed error with status code
 */
export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly errorType: string;

  constructor(statusCode: number, message: string, errorType?: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.errorType = errorType || getErrorTypeForStatus(statusCode);
  }
}

/**
 * Create common HTTP errors
 */
export const Errors = {
  badRequest: (message: string) => new HttpError(400, message, ErrorTypes.VALIDATION_ERROR),
  unauthorized: (message: string) => new HttpError(401, message, ErrorTypes.UNAUTHORIZED),
  forbidden: (message: string) => new HttpError(403, message, ErrorTypes.FORBIDDEN),
  notFound: (message: string) => new HttpError(404, message, ErrorTypes.NOT_FOUND),
  conflict: (message: string) => new HttpError(409, message, ErrorTypes.CONFLICT),
  internal: (message: string) => new HttpError(500, message, ErrorTypes.INTERNAL),
};
