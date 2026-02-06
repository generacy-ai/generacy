/**
 * Authentication types for the Cloud Build plugin.
 */

import type { CloudBuildClient } from '@google-cloud/cloudbuild';
import type { Storage } from '@google-cloud/storage';

export interface AuthOptions {
  projectId: string;
  serviceAccountKey?: string;
}

export interface AuthProvider {
  getCloudBuildClient(): CloudBuildClient;
  getStorageClient(): Storage;
}

export interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}
