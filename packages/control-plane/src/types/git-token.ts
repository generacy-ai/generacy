export interface GitTokenCacheEntry {
  token: string;
  expiresAt: Date;
  credentialId: string;
  fetchedAt: Date;
}

export type GitHelperErrorCode =
  | 'CLUSTER_API_KEY_MISSING'
  | 'CLOUD_UNREACHABLE'
  | 'CLOUD_AUTH_REJECTED'
  | 'CLOUD_REQUEST_INVALID'
  | 'CLOUD_UPSTREAM_ERROR'
  | 'CLOUD_RESPONSE_INVALID'
  | 'CREDENTIAL_NOT_CONFIGURED';

export class GitHelperError extends Error {
  readonly code: GitHelperErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: GitHelperErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'GitHelperError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface CloudPullRequest {
  credentialId: string;
}

export interface CloudPullResponse {
  token: string;
  expiresAt: string;
}

export interface GitTokenResponse {
  token: string;
  expiresAt: string;
}
