/**
 * Authentication provider for the Cloud Build plugin.
 *
 * Priority order:
 * 1. Explicit serviceAccountKey in config (highest priority)
 * 2. Application Default Credentials (ADC) as fallback
 */

import { CloudBuildClient } from '@google-cloud/cloudbuild';
import { Storage } from '@google-cloud/storage';
import type { AuthOptions, AuthProvider, ServiceAccountCredentials } from './types.js';
import { AuthError } from '../errors.js';

export class DefaultAuthProvider implements AuthProvider {
  private readonly projectId: string;
  private readonly credentials?: ServiceAccountCredentials;
  private cloudBuildClient?: CloudBuildClient;
  private storageClient?: Storage;

  constructor(options: AuthOptions) {
    this.projectId = options.projectId;

    if (options.serviceAccountKey) {
      try {
        this.credentials = JSON.parse(options.serviceAccountKey) as ServiceAccountCredentials;
      } catch {
        throw new AuthError('Invalid service account key JSON', {
          reason: 'Failed to parse serviceAccountKey as JSON',
        });
      }
    }
  }

  getCloudBuildClient(): CloudBuildClient {
    if (!this.cloudBuildClient) {
      this.cloudBuildClient = this.createCloudBuildClient();
    }
    return this.cloudBuildClient;
  }

  getStorageClient(): Storage {
    if (!this.storageClient) {
      this.storageClient = this.createStorageClient();
    }
    return this.storageClient;
  }

  private createCloudBuildClient(): CloudBuildClient {
    if (this.credentials) {
      return new CloudBuildClient({
        projectId: this.projectId,
        credentials: this.credentials,
      });
    }

    // Use Application Default Credentials
    return new CloudBuildClient({
      projectId: this.projectId,
    });
  }

  private createStorageClient(): Storage {
    if (this.credentials) {
      return new Storage({
        projectId: this.projectId,
        credentials: this.credentials,
      });
    }

    // Use Application Default Credentials
    return new Storage({
      projectId: this.projectId,
    });
  }
}

/**
 * Create an auth provider from options.
 */
export function createAuthProvider(options: AuthOptions): AuthProvider {
  return new DefaultAuthProvider(options);
}
