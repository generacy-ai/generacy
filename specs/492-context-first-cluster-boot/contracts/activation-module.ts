/**
 * Type contract for the activation module's public API.
 * This is the interface between the activation module and the orchestrator entry point.
 */

import type { Logger } from 'pino';

// --- Public API ---

export interface ActivationOptions {
  /** Base URL of the Generacy cloud (e.g. https://api.generacy.ai) */
  cloudUrl: string;
  /** Path to the cluster API key file (default: /var/lib/generacy/cluster-api-key) */
  keyFilePath: string;
  /** Path to the cluster metadata JSON file (default: /var/lib/generacy/cluster.json) */
  clusterJsonPath: string;
  /** Pino logger instance */
  logger: Logger;
  /** Max device-code request cycles on expiry (default: 3) */
  maxCycles?: number;
  /** Max retries for initial HTTP request when cloud is unreachable (default: 5) */
  maxRetries?: number;
  /** Injectable HTTP client for testing */
  httpClient?: HttpClient;
}

export interface ActivationResult {
  /** The cluster API key (secret - never log) */
  apiKey: string;
  /** Key ID prefix for diagnostics (non-secret) */
  clusterApiKeyId?: string;
  /** Assigned cluster ID */
  clusterId: string;
  /** Project the cluster belongs to */
  projectId: string;
  /** Organization the cluster belongs to */
  orgId: string;
}

/**
 * Main entry point for cluster activation.
 *
 * - If key file exists: reads and returns the existing key + metadata
 * - If key file absent: runs device-code flow, persists, returns result
 * - Throws ActivationError on unrecoverable failure
 */
export type ActivateFn = (options: ActivationOptions) => Promise<ActivationResult>;

// --- Injectable HTTP Client ---

export interface HttpClient {
  post<T>(url: string, body?: unknown): Promise<HttpResponse<T>>;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
}

// --- Error Types ---

export type ActivationErrorCode =
  | 'CLOUD_UNREACHABLE'
  | 'DEVICE_CODE_EXPIRED'
  | 'KEY_WRITE_FAILED'
  | 'INVALID_RESPONSE';
