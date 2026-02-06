/**
 * Cloud Build API client wrapper.
 *
 * Wraps @google-cloud/cloudbuild with:
 * - Authentication integration
 * - Error handling
 * - Retry logic for transient failures
 */

import { CloudBuildClient } from '@google-cloud/cloudbuild';
import { Storage } from '@google-cloud/storage';
import type { Logger } from 'pino';
import type { CloudBuildConfig } from './config/types.js';
import type { AuthProvider } from './auth/types.js';
import { createAuthProvider } from './auth/auth-provider.js';
import { withRetry, shouldRetryError } from './utils/retry.js';
import {
  CloudBuildError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  AuthError,
  mapStatusToErrorCode,
  wrapError,
} from './errors.js';

export interface CloudBuildClientWrapper {
  readonly cloudBuild: CloudBuildClient;
  readonly storage: Storage;
  readonly projectId: string;
  readonly location: string;

  /**
   * Execute an operation with retry logic.
   */
  withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T>;
}

export class DefaultCloudBuildClient implements CloudBuildClientWrapper {
  readonly cloudBuild: CloudBuildClient;
  readonly storage: Storage;
  readonly projectId: string;
  readonly location: string;

  private readonly config: CloudBuildConfig;
  private readonly logger: Logger;

  constructor(config: CloudBuildConfig, logger: Logger, authProvider?: AuthProvider) {
    this.config = config;
    this.logger = logger;
    this.projectId = config.projectId;
    this.location = config.location;

    const provider = authProvider ?? createAuthProvider({
      projectId: config.projectId,
      serviceAccountKey: config.serviceAccountKey,
    });

    this.cloudBuild = provider.getCloudBuildClient();
    this.storage = provider.getStorageClient();
  }

  async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    return withRetry(operation, {
      ...this.config.retry,
      shouldRetry: shouldRetryError,
      onRetry: (error, attempt, delayMs) => {
        this.logger.warn(
          { error, attempt, delayMs, operation: operationName },
          `Retrying ${operationName} after transient error`
        );
      },
    });
  }
}

/**
 * Create a Cloud Build client wrapper.
 */
export function createCloudBuildClient(
  config: CloudBuildConfig,
  logger: Logger,
  authProvider?: AuthProvider
): CloudBuildClientWrapper {
  return new DefaultCloudBuildClient(config, logger, authProvider);
}

/**
 * Map Google Cloud API errors to CloudBuildError.
 */
export function mapApiError(error: unknown, context?: Record<string, unknown>): CloudBuildError {
  if (error instanceof CloudBuildError) {
    return error;
  }

  // Handle gRPC errors from Google Cloud libraries
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // gRPC status code
    if ('code' in err && typeof err.code === 'number') {
      const code = err.code;
      const message = 'message' in err ? String(err.message) : 'Unknown error';

      switch (code) {
        case 3: // INVALID_ARGUMENT
          return new CloudBuildError(message, 'INVALID_ARGUMENT', false, context);
        case 5: // NOT_FOUND
          return new NotFoundError('Resource', 'unknown');
        case 7: // PERMISSION_DENIED
          return new CloudBuildError(message, 'PERMISSION_DENIED', false, context);
        case 8: // RESOURCE_EXHAUSTED
          return new RateLimitError(message);
        case 14: // UNAVAILABLE
          return new ServiceUnavailableError(message);
        case 16: // UNAUTHENTICATED
          return new AuthError(message, context);
        default:
          return new CloudBuildError(message, mapStatusToErrorCode(code), code === 14 || code === 8, context);
      }
    }

    // HTTP status code
    if ('status' in err && typeof err.status === 'number') {
      const status = err.status;
      const message = 'message' in err ? String(err.message) : 'Unknown error';

      return new CloudBuildError(
        message,
        mapStatusToErrorCode(status),
        status === 429 || status === 503 || status === 504,
        context
      );
    }
  }

  return wrapError(error);
}
