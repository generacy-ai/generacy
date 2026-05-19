import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ClusterRegistrySchema, type ClusterRegistry, type ClusterEntry } from './schema.js';

const REGISTRY_DIR = join(homedir(), '.generacy');
const REGISTRY_PATH = join(REGISTRY_DIR, 'clusters.json');

export async function loadRegistry(): Promise<ClusterRegistry> {
  try {
    const data = await readFile(REGISTRY_PATH, 'utf-8');
    return ClusterRegistrySchema.parse(JSON.parse(data));
  } catch {
    return { version: 1, clusters: [] };
  }
}

export async function saveRegistry(registry: ClusterRegistry): Promise<void> {
  await mkdir(REGISTRY_DIR, { recursive: true });
  const tmpPath = REGISTRY_PATH + '.tmp';
  const content = JSON.stringify(registry, null, 2) + '\n';
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, REGISTRY_PATH);
}

export async function addCluster(entry: ClusterEntry): Promise<void> {
  const registry = await loadRegistry();
  registry.clusters = registry.clusters.filter(c => c.id !== entry.id);
  registry.clusters.push(entry);
  await saveRegistry(registry);
}

export async function removeCluster(id: string): Promise<void> {
  const registry = await loadRegistry();
  registry.clusters = registry.clusters.filter(c => c.id !== id);
  await saveRegistry(registry);
}
