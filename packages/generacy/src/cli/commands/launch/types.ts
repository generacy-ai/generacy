/**
 * Types for the `generacy launch` command — claim-code first-run flow.
 */
import { z } from 'zod';

/**
 * CLI-parsed options passed to the launch handler.
 */
export interface LaunchOptions {
  claim?: string;
  dir?: string;
  apiUrl?: string;
  cloudUrl?: string;
  logLevel?: string;
}

/**
 * Structured cloud URL triplet sent by the cloud in LaunchConfig.
 * When present, consumers use these directly instead of deriving URLs.
 */
export const CloudUrlsSchema = z.object({
  apiUrl: z.string().url(),
  appUrl: z.string().url(),
  relayUrl: z.string().url(),
});

export type CloudUrls = z.infer<typeof CloudUrlsSchema>;

/**
 * Schema for a registry credential entry (host + username + password).
 *
 * The cloud sends plain username/password; consumers compute base64 auth
 * locally — pullImage for the scoped Docker config, and
 * forwardRegistryCredentials for the credhelper PUT body.
 */
export const RegistryCredentialSchema = z.object({
  host: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

export type RegistryCredential = z.infer<typeof RegistryCredentialSchema>;

/**
 * Zod schema for the cloud launch-config response.
 */
export const LaunchConfigSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  variant: z.string().min(1),
  channel: z.enum(['stable', 'preview']).optional(),
  cloudUrl: z.string().url(),
  clusterId: z.string().min(1),
  imageTag: z.string().min(1),
  orgId: z.string().min(1),
  repos: z.object({
    primary: z.string().min(1),
    dev: z.array(z.string()).optional(),
    clone: z.array(z.string()).optional(),
  }),
  cloud: CloudUrlsSchema.optional(),
  registryCredentials: z.array(RegistryCredentialSchema).optional(),
});

/**
 * Response from GET /api/clusters/launch-config?claim=<code>.
 */
export type LaunchConfig = z.infer<typeof LaunchConfigSchema>;
