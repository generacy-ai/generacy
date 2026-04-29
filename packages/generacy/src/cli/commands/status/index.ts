import { Command } from 'commander';
import { execSafe } from '../../utils/exec.js';
import { readRegistry } from '../cluster/registry.js';
import {
  deriveState,
  formatTable,
  formatJson,
  type ClusterStatus,
  type ServiceStatus,
} from './formatter.js';

function getClusterServices(composePath: string, projectName: string): ServiceStatus[] {
  const result = execSafe(
    `docker compose --project-name=${projectName} --file=${composePath} ps --format json`,
  );
  if (!result.ok || !result.stdout.trim()) {
    return [];
  }

  try {
    // docker compose ps --format json outputs one JSON object per line (NDJSON)
    const lines = result.stdout.trim().split('\n');
    return lines.map((line) => {
      const obj = JSON.parse(line);
      return {
        name: obj.Name ?? obj.Service ?? '',
        state: (obj.State ?? 'stopped').toLowerCase(),
        status: obj.Status ?? '',
      };
    });
  } catch {
    return [];
  }
}

export function statusCommand(): Command {
  return new Command('status')
    .description('List all registered clusters with current Docker state')
    .option('--json', 'Output as JSON', false)
    .action(async (options: { json: boolean }) => {
      const registry = readRegistry();
      const statuses: ClusterStatus[] = registry.map((entry) => {
        const services = getClusterServices(
          entry.composePath,
          entry.clusterId ?? entry.name,
        );
        return {
          clusterId: entry.clusterId,
          name: entry.name,
          path: entry.path,
          variant: entry.variant,
          channel: entry.channel,
          state: deriveState(services),
          services,
          lastSeen: entry.lastSeen,
          createdAt: entry.createdAt,
        };
      });

      if (options.json) {
        console.log(formatJson(statuses));
      } else {
        console.log(formatTable(statuses));
      }
    });
}
