import { z } from 'zod';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { getLogger } from '../../utils/logger.js';

// -- Zod Schemas --

export const ClusterYamlSchema = z.object({
  channel: z.enum(['stable', 'preview']).default('stable'),
  workers: z.number().int().positive().default(1),
  variant: z.enum(['standard', 'microservices']).default('standard'),
});

export type ClusterYaml = z.infer<typeof ClusterYamlSchema>;

export const ClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime(),
});

export type ClusterJson = z.infer<typeof ClusterJsonSchema>;

// -- ClusterContext --

export interface ClusterContext {
  projectRoot: string;
  generacyDir: string;
  composePath: string;
  clusterConfig: ClusterYaml;
  clusterIdentity: ClusterJson | null;
  projectName: string;
}

// -- getClusterContext --

export function getClusterContext(cwd?: string): ClusterContext {
  const logger = getLogger();
  const startDir = cwd ?? process.cwd();
  let dir = path.resolve(startDir);

  // Walk upward to find .generacy/cluster.yaml
  for (;;) {
    const clusterYamlPath = path.join(dir, '.generacy', 'cluster.yaml');
    if (fs.existsSync(clusterYamlPath)) {
      const generacyDir = path.join(dir, '.generacy');
      const composePath = path.join(generacyDir, 'docker-compose.yml');

      if (!fs.existsSync(composePath)) {
        throw new Error(
          `Compose file missing at ${composePath}. Run 'generacy init' to create it.`,
        );
      }

      // Parse cluster.yaml
      const yamlContent = fs.readFileSync(clusterYamlPath, 'utf-8');
      const clusterConfig = ClusterYamlSchema.parse(parseYaml(yamlContent) ?? {});

      // Parse cluster.json (optional — may not exist pre-activation)
      let clusterIdentity: ClusterJson | null = null;
      const clusterJsonPath = path.join(generacyDir, 'cluster.json');
      if (fs.existsSync(clusterJsonPath)) {
        const jsonContent = fs.readFileSync(clusterJsonPath, 'utf-8');
        clusterIdentity = ClusterJsonSchema.parse(JSON.parse(jsonContent));
      }

      // Compute project name
      const projectName = clusterIdentity?.cluster_id ?? path.basename(dir);
      if (!clusterIdentity) {
        logger.warn(
          'No cluster.json found (pre-activation). Using directory name "%s" as compose project name.',
          projectName,
        );
      }

      return {
        projectRoot: dir,
        generacyDir,
        composePath,
        clusterConfig,
        clusterIdentity,
        projectName,
      };
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  throw new Error("No cluster found. Run 'generacy init' first.");
}
