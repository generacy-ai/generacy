/**
 * RFC 7807 Problem Details for HTTP APIs
 * @see https://datatracker.ietf.org/doc/html/rfc7807
 */

/**
 * Standard RFC 7807 Problem Details response
 */
export interface ProblemDetails {
  /** URI reference identifying the problem type */
  type: string;
  /** Short, human-readable summary of the problem */
  title: string;
  /** HTTP status code */
  status: number;
  /** Human-readable explanation specific to this occurrence */
  detail?: string;
  /** URI reference identifying the specific occurrence */
  instance?: string;
  /** Machine-readable error code */
  code?: string;
  /** Validation errors for request body */
  errors?: ValidationError[];
  /** Request correlation ID for tracing */
  traceId?: string;
}

/**
 * Validation error for a specific field
 */
export interface ValidationError {
  /** Field path (e.g., "body.email" or "query.page") */
  field: string;
  /** Human-readable error message */
  message: string;
  /** Machine-readable error code */
  code: string;
}

/**
 * Error type URIs for Generacy API
 */
export const ErrorTypes = {
  /** Request validation failed */
  VALIDATION_ERROR: 'urn:generacy:error:validation',
  /** Resource not found */
  NOT_FOUND: 'urn:generacy:error:not-found',
  /** Authentication required or invalid */
  UNAUTHORIZED: 'urn:generacy:error:unauthorized',
  /** Authenticated but not permitted */
  FORBIDDEN: 'urn:generacy:error:forbidden',
  /** Rate limit exceeded */
  RATE_LIMITED: 'urn:generacy:error:rate-limited',
  /** Conflict with current state */
  CONFLICT: 'urn:generacy:error:conflict',
  /** Internal server error */
  INTERNAL: 'urn:generacy:error:internal',
  /** Service unavailable */
  SERVICE_UNAVAILABLE: 'urn:generacy:error:service-unavailable',
} as const;

export type ErrorType = (typeof ErrorTypes)[keyof typeof ErrorTypes];

/**
 * Create a ProblemDetails response
 */
export function createProblemDetails(
  type: ErrorType,
  title: string,
  status: number,
  options?: Partial<Omit<ProblemDetails, 'type' | 'title' | 'status'>>
): ProblemDetails {
  return {
    type,
    title,
    status,
    ...options,
  };
}
