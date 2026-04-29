import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from './logger.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ProjectClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime(),
});

export const ClusterRegistryEntrySchema = z.object({
  clusterId: z.string().min(1),
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  cloudUrl: z.string().url(),
  path: z.string().min(1),
  activatedAt: z.string().datetime(),
  status: z.enum(['running', 'stopped', 'unknown']).optional(),
});

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

export interface ClusterContext {
  clusterId: string;
  projectId: string;
  orgId: string;
  cloudUrl: string;
  generacyDir: string;
  projectDir: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function findGeneracyDir(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = dirname(dir) === dir ? dir : undefined;

  while (true) {
    const candidate = join(dir, '.generacy', 'cluster.json');
    try {
      readFileSync(candidate);
      return join(dir, '.generacy');
    } catch {
      // not found, keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

function readRegistry(): ClusterRegistry | null {
  const registryPath = join(homedir(), '.generacy', 'clusters.json');
  try {
    const raw = readFileSync(registryPath, 'utf-8');
    return ClusterRegistrySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function getClusterContext(options: {
  startDir?: string;
  clusterId?: string;
} = {}): Promise<ClusterContext> {
  const logger = getLogger();

  // --cluster <id> override: look up from registry
  if (options.clusterId) {
    const registry = readRegistry();
    if (!registry) {
      throw new Error(
        `Cluster '${options.clusterId}' not found in registry. Run 'generacy status' to see available clusters.`,
      );
    }
    const entry = registry.clusters.find((c) => c.clusterId === options.clusterId);
    if (!entry) {
      throw new Error(
        `Cluster '${options.clusterId}' not found in registry. Run 'generacy status' to see available clusters.`,
      );
    }
    return {
      clusterId: entry.clusterId,
      projectId: entry.projectId,
      orgId: entry.orgId,
      cloudUrl: entry.cloudUrl,
      generacyDir: join(entry.path, '.generacy'),
      projectDir: entry.path,
    };
  }

  // Walk up from cwd to find .generacy/cluster.json
  const startDir = options.startDir ?? process.cwd();
  const generacyDir = findGeneracyDir(startDir);
  if (!generacyDir) {
    throw new Error(
      `No Generacy cluster found in ${startDir} or any parent directory. Run 'generacy init' first.`,
    );
  }

  const clusterJsonPath = join(generacyDir, 'cluster.json');
  let raw: string;
  try {
    raw = readFileSync(clusterJsonPath, 'utf-8');
  } catch {
    throw new Error("Cluster configuration is corrupted. Re-run 'generacy init'.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Cluster configuration is corrupted. Re-run 'generacy init'.");
  }

  const result = ProjectClusterJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Cluster configuration is corrupted. Re-run 'generacy init'.");
  }

  const projectDir = dirname(generacyDir);
  const context: ClusterContext = {
    clusterId: result.data.cluster_id,
    projectId: result.data.project_id,
    orgId: result.data.org_id,
    cloudUrl: result.data.cloud_url,
    generacyDir,
    projectDir,
  };

  // Cross-reference with registry for additional metadata (e.g., status)
  const registry = readRegistry();
  if (registry) {
    const entry = registry.clusters.find((c) => c.clusterId === context.clusterId);
    if (entry) {
      logger.debug({ clusterId: context.clusterId, status: entry.status }, 'Cluster found in registry');
    }
  }

  return context;
}
