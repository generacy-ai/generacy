import http from 'node:http';

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_ROLE'
  | 'ROLE_NOT_FOUND'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_MINT_FAILED'
  | 'PLUGIN_RESOLVE_FAILED'
  | 'UNSUPPORTED_EXPOSURE'
  | 'NOT_IMPLEMENTED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CREDENTIAL_EXPIRED'
  | 'BACKEND_UNREACHABLE'
  | 'PEER_REJECTED'
  | 'INTERNAL_ERROR';

export interface CredhelperErrorResponse {
  error: string;
  code: ErrorCode;
  details?: Record<string, unknown>;
}

const HTTP_STATUS_MAP: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  INVALID_ROLE: 400,
  UNSUPPORTED_EXPOSURE: 400,
  ROLE_NOT_FOUND: 404,
  PLUGIN_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  CREDENTIAL_NOT_FOUND: 404,
  SESSION_EXPIRED: 410,
  CREDENTIAL_EXPIRED: 410,
  PEER_REJECTED: 403,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  PLUGIN_MINT_FAILED: 502,
  PLUGIN_RESOLVE_FAILED: 502,
  BACKEND_UNREACHABLE: 502,
};

export class CredhelperError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CredhelperError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS_MAP[this.code];
  }

  toResponse(): CredhelperErrorResponse {
    const response: CredhelperErrorResponse = {
      error: this.message,
      code: this.code,
    };
    if (this.details !== undefined) {
      response.details = this.details;
    }
    return response;
  }
}

export function sendError(res: http.ServerResponse, error: CredhelperError): void {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(error.httpStatus);
  res.end(JSON.stringify(error.toResponse()));
}
