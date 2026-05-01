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
  logLevel?: string;
}

/**
 * Zod schema for the cloud launch-config response.
 */
export const LaunchConfigSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  variant: z.string().min(1),
  cloudUrl: z.string().url(),
  clusterId: z.string().min(1),
  imageTag: z.string().min(1),
  orgId: z.string().min(1),
  repos: z.object({
    primary: z.string().min(1),
    dev: z.array(z.string()).optional(),
    clone: z.array(z.string()).optional(),
  }),
});

/**
 * Response from GET /api/clusters/launch-config?claim=<code>.
 */
export type LaunchConfig = z.infer<typeof LaunchConfigSchema>;

