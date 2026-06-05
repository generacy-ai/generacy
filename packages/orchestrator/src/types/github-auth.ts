import { z } from 'zod';

/** Per-credential authentication health state. */
export type GitHubAuthStatus = 'ok' | 'failing' | 'unknown';

/**
 * Public snapshot rendered on `/health.githubAuth`.
 * Matches `contracts/github-auth-health.schema.json`.
 */
export interface GitHubAuthSnapshot {
  status: GitHubAuthStatus;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  credentialId?: string;
  expiresAt?: string;
}

/**
 * Internal per-credential bookkeeping inside `GitHubAuthHealthService`.
 * Epoch-ms fields are converted to ISO strings on snapshot.
 */
export interface PerCredentialState {
  credentialId: string;
  status: GitHubAuthStatus;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  expiresAtMs?: number;
  lastRefreshRequestAtMs?: number;
}

/** Descriptor parsed from `<agencyDir>/credentials.yaml`. */
export interface CredentialDescriptor {
  credentialId: string;
  type: 'github-app' | 'github-pat' | 'anthropic' | 'api-key' | string;
  expiresAt?: string;
}

const credentialIdSchema = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);

export const RefreshRequestedSchema = z.object({
  action: z.literal('refresh-requested'),
  credentialId: credentialIdSchema,
  type: z.literal('github-app'),
  expiresAt: z.string().datetime().optional(),
  reason: z.string().optional(),
});

export const AuthFailedSchema = z.object({
  action: z.literal('auth-failed'),
  credentialId: credentialIdSchema,
  type: z.literal('github-app'),
  consecutiveFailures: z.number().int().min(1),
  reason: z.string().optional(),
});

export const AuthRecoveredSchema = z.object({
  action: z.literal('auth-recovered'),
  credentialId: credentialIdSchema,
  type: z.literal('github-app'),
  recoveredAfterFailures: z.number().int().min(1),
});

export const CredentialsEventPayloadSchema = z.discriminatedUnion('action', [
  RefreshRequestedSchema,
  AuthFailedSchema,
  AuthRecoveredSchema,
]);

export type CredentialsEventPayload = z.infer<typeof CredentialsEventPayloadSchema>;

export const GitHubAuthSnapshotSchema = z.object({
  status: z.enum(['ok', 'failing', 'unknown']),
  consecutiveFailures: z.number().int().min(0),
  lastSuccessAt: z.string().datetime().optional(),
  credentialId: credentialIdSchema.optional(),
  expiresAt: z.string().datetime().optional(),
});
