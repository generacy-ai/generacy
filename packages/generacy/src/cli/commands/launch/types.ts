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
  repos: z.object({
    primary: z.string().min(1),
    dev: z.string().optional(),
    clone: z.string().optional(),
  }),
});

/**
 * Response from GET /api/clusters/launch-config?claim=<code>.
 */
export type LaunchConfig = z.infer<typeof LaunchConfigSchema>;

/**
 * Entry in ~/.generacy/clusters.json. Schema defined by #494.
 */
export interface ClusterRegistryEntry {
  clusterId: string;
  name: string;
  path: string;
  composePath: string;
  variant: string;
  channel: string;
  cloudUrl: string;
  lastSeen: string;
  createdAt: string;
}

/**
 * Full registry file at ~/.generacy/clusters.json.
 */
export type ClusterRegistry = ClusterRegistryEntry[];

/**
 * Runtime cluster config written to .generacy/cluster.yaml.
 */
export interface ClusterYaml {
  variant: string;
  imageTag: string;
  cloudUrl: string;
  ports: {
    orchestrator: number;
    relay: number;
    controlPlane: number;
  };
}

/**
 * Machine-readable metadata written to .generacy/cluster.json.
 */
export interface ClusterMetadata {
  clusterId: string;
  projectId: string;
  projectName: string;
  variant: string;
  cloudUrl: string;
  imageTag: string;
  createdAt: string;
}
