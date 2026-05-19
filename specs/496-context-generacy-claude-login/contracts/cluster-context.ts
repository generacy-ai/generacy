/**
 * Contract: Cluster Context Resolution
 *
 * Shared helper for resolving which cluster is associated with a
 * working directory. Used by claude-login, open, and #494 lifecycle commands.
 *
 * @module packages/generacy/src/cli/utils/cluster-context.ts
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Per-project cluster identity at .generacy/cluster.json */
export const ProjectClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime(),
});

/** Entry in ~/.generacy/clusters.json */
export const ClusterRegistryEntrySchema = z.object({
  clusterId: z.string().min(1),
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  cloudUrl: z.string().url(),
  path: z.string().min(1),
  activatedAt: z.string().datetime(),
  status: z.enum(['running', 'stopped', 'unknown']).optional(),
});

/** Host-side cluster registry */
export const ClusterRegistrySchema = z.object({
  version: z.literal(1),
  clusters: z.array(ClusterRegistryEntrySchema),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectClusterJson = z.infer<typeof ProjectClusterJsonSchema>;
export type ClusterRegistryEntry = z.infer<typeof ClusterRegistryEntrySchema>;
export type ClusterRegistry = z.infer<typeof ClusterRegistrySchema>;

/** Resolved cluster identity for CLI commands */
export interface ClusterContext {
  clusterId: string;
  projectId: string;
  orgId: string;
  cloudUrl: string;
  generacyDir: string;
  projectDir: string;
}

// ---------------------------------------------------------------------------
// API Contract
// ---------------------------------------------------------------------------

/**
 * Resolve cluster context from cwd or explicit cluster ID.
 *
 * Resolution order:
 * 1. If clusterId is provided, look up ~/.generacy/clusters.json by ID
 * 2. Otherwise, walk up from startDir looking for .generacy/cluster.json
 * 3. Cross-reference with ~/.generacy/clusters.json for additional metadata
 *
 * @throws {Error} "No Generacy cluster found" — no .generacy/ in ancestry
 * @throws {Error} "Cluster configuration is corrupted" — invalid cluster.json
 * @throws {Error} "Cluster '{id}' not found in registry" — --cluster lookup miss
 */
export type GetClusterContext = (options: {
  startDir?: string;     // defaults to process.cwd()
  clusterId?: string;    // explicit --cluster <id> override
}) => Promise<ClusterContext>;
