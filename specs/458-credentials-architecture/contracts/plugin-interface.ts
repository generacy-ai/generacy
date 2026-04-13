/**
 * @generacy-ai/credhelper — Plugin Interface Contract
 *
 * This is the reference contract for CredentialTypePlugin implementations.
 * The actual runtime types live in packages/credhelper/src/types/.
 *
 * Every credential type plugin (github-app, gcp-service-account, etc.)
 * must implement this interface.
 */

import type { ZodSchema } from 'zod';

// --- Secret ---

export interface Secret {
  value: string;
  format?: 'token' | 'json' | 'key' | 'opaque';
}

// --- Exposure Types ---

export type ExposureKind =
  | 'env'
  | 'git-credential-helper'
  | 'gcloud-external-account'
  | 'localhost-proxy'
  | 'docker-socket-proxy';

export type ExposureConfig =
  | { kind: 'env'; name: string }
  | { kind: 'git-credential-helper' }
  | { kind: 'gcloud-external-account' }
  | { kind: 'localhost-proxy'; port: number }
  | { kind: 'docker-socket-proxy' };

export type ExposureOutput =
  | { kind: 'env'; entries: Array<{ key: string; value: string }> }
  | { kind: 'git-credential-helper'; script: string }
  | { kind: 'gcloud-external-account'; json: object }
  | { kind: 'localhost-proxy'; proxyConfig: { port: number; upstream: string; headers: Record<string, string> } }
  | { kind: 'docker-socket-proxy'; socketPath: string };

// --- Backend Client ---

export interface BackendClient {
  fetchSecret(key: string): Promise<string>;
}

// --- Contexts ---

export interface MintContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
  scope: Record<string, unknown>;
  ttl: number;
}

export interface ResolveContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
}

// --- Plugin Interface ---

export interface CredentialTypePlugin {
  /** Unique type identifier, e.g. "github-app", "gcp-service-account" */
  type: string;

  /** Zod schema that validates entries in credentials.yaml for this type */
  credentialSchema: ZodSchema;

  /** Optional Zod schema that validates role `scope:` blocks for this type */
  scopeSchema?: ZodSchema;

  /** Which exposure mechanisms this type supports. Role validation fails closed. */
  supportedExposures: ExposureKind[];

  /** Mint a short-lived derived credential (e.g. GitHub App installation token) */
  mint?(ctx: MintContext): Promise<{ value: Secret; expiresAt: Date }>;

  /** Resolve a static credential (e.g. read a PAT from the backend) */
  resolve?(ctx: ResolveContext): Promise<Secret>;

  /** Render a resolved secret into a specific exposure form */
  renderExposure(
    kind: ExposureKind,
    secret: Secret,
    cfg: ExposureConfig,
  ): ExposureOutput;
}
