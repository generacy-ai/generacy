import http from 'node:http';

export type ControlPlaneErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'UNKNOWN_ACTION'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ControlPlaneErrorResponse {
  error: string;
  code: ControlPlaneErrorCode;
  details?: Record<string, unknown>;
}

const HTTP_STATUS_MAP: Record<ControlPlaneErrorCode, number> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  UNKNOWN_ACTION: 400,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ControlPlaneErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ControlPlaneError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS_MAP[this.code];
  }

  toResponse(): ControlPlaneErrorResponse {
    const response: ControlPlaneErrorResponse = {
      error: this.message,
      code: this.code,
    };
    if (this.details !== undefined) {
      response.details = this.details;
    }
    return response;
  }
}

export function sendError(res: http.ServerResponse, error: ControlPlaneError): void {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(error.httpStatus);
  res.end(JSON.stringify(error.toResponse()));
}
