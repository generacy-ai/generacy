import { resolve } from 'node:path';
import { loadRegistry } from './registry.js';
import type { ClusterEntry } from './schema.js';

export async function findClusterByCwd(cwd?: string): Promise<ClusterEntry | undefined> {
  const resolved = resolve(cwd ?? process.cwd());
  const registry = await loadRegistry();

  let best: ClusterEntry | undefined;
  let bestLen = -1;

  for (const cluster of registry.clusters) {
    const clusterPath = resolve(cluster.path);
    if (resolved === clusterPath || resolved.startsWith(clusterPath + '/')) {
      if (clusterPath.length > bestLen) {
        best = cluster;
        bestLen = clusterPath.length;
      }
    }
  }

  return best;
}
