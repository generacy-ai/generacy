import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getLogger } from '../../utils/logger.js';
import type { ClusterContext } from './context.js';

export const RegistryEntrySchema = z.object({
  clusterId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  composePath: z.string(),
  variant: z.enum(['standard', 'microservices']).default('standard'),
  channel: z.enum(['stable', 'preview']).default('stable'),
  cloudUrl: z.string().nullable(),
  lastSeen: z.string().datetime(),
  createdAt: z.string().datetime(),
  managementEndpoint: z.string().optional(),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistrySchema = z.array(RegistryEntrySchema);
export type Registry = z.infer<typeof RegistrySchema>;

function registryPath(): string {
  return path.join(os.homedir(), '.generacy', 'clusters.json');
}

export function readRegistry(): Registry {
  const filePath = registryPath();
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return RegistrySchema.parse(JSON.parse(content));
}

export function writeRegistry(registry: Registry): void {
  const filePath = registryPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function upsertRegistryEntry(ctx: ClusterContext): void {
  const logger = getLogger();
  const registry = readRegistry();
  const now = new Date().toISOString();

  const idx = registry.findIndex((e) => e.path === ctx.projectRoot);
  const entry: RegistryEntry = {
    clusterId: ctx.clusterIdentity?.cluster_id ?? null,
    name: path.basename(ctx.projectRoot),
    path: ctx.projectRoot,
    composePath: ctx.composePath,
    variant: ctx.clusterConfig.variant,
    channel: ctx.clusterConfig.channel,
    cloudUrl: ctx.clusterIdentity?.cloud_url ?? null,
    lastSeen: now,
    createdAt: idx >= 0 ? registry[idx]!.createdAt : now,
  };

  if (idx >= 0) {
    registry[idx] = entry;
    logger.debug({ path: ctx.projectRoot }, 'Updated registry entry');
  } else {
    registry.push(entry);
    logger.debug({ path: ctx.projectRoot }, 'Added registry entry');
  }

  writeRegistry(registry);
}

export function removeRegistryEntry(projectPath: string): void {
  const logger = getLogger();
  const registry = readRegistry();
  const filtered = registry.filter((e) => e.path !== projectPath);
  if (filtered.length < registry.length) {
    writeRegistry(filtered);
    logger.debug({ path: projectPath }, 'Removed registry entry');
  }
}
