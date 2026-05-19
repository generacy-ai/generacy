import { execSync } from 'node:child_process';
import type { ClusterMetadata, GitRemote } from './messages.js';
import type { RelayConfig } from './config.js';

/**
 * Collect cluster metadata by querying the local orchestrator's
 * /health and /metrics endpoints, and parsing git remotes.
 */
export async function collectMetadata(
  config: RelayConfig,
): Promise<ClusterMetadata> {
  const [health, metrics, gitRemotes] = await Promise.all([
    fetchHealth(config),
    fetchMetrics(config),
    parseGitRemotes(),
  ]);

  return {
    workerCount: metrics.workerCount,
    activeWorkflows: metrics.activeWorkflows,
    channel: health.channel,
    orchestratorVersion: health.version,
    gitRemotes,
    uptime: health.uptime,
    codeServerReady: health.codeServerReady,
    controlPlaneReady: health.controlPlaneReady,
  };
}

interface HealthData {
  version: string;
  channel: 'preview' | 'stable';
  uptime: number;
  codeServerReady: boolean;
  controlPlaneReady: boolean;
}

async function fetchHealth(config: RelayConfig): Promise<HealthData> {
  try {
    const response = await fetch(`${config.orchestratorUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      return {
        version: String(data['version'] ?? '0.0.0'),
        channel: (data['channel'] === 'preview' ? 'preview' : 'stable') as 'preview' | 'stable',
        uptime: Number(data['uptime'] ?? 0),
        codeServerReady: data['codeServerReady'] === true,
        controlPlaneReady: data['controlPlaneReady'] === true,
      };
    }
  } catch {
    // Orchestrator unreachable — use defaults
  }
  return { version: '0.0.0', channel: 'stable', uptime: 0, codeServerReady: false, controlPlaneReady: false };
}

interface MetricsData {
  workerCount: number;
  activeWorkflows: number;
}

async function fetchMetrics(config: RelayConfig): Promise<MetricsData> {
  try {
    const response = await fetch(`${config.orchestratorUrl}/metrics`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      return {
        workerCount: Number(data['workerCount'] ?? 0),
        activeWorkflows: Number(data['activeWorkflows'] ?? 0),
      };
    }
  } catch {
    // Orchestrator unreachable — use defaults
  }
  return { workerCount: 0, activeWorkflows: 0 };
}

/**
 * Parse git remotes from `git remote -v`.
 */
async function parseGitRemotes(): Promise<GitRemote[]> {
  try {
    const output = execSync('git remote -v', { encoding: 'utf-8', timeout: 5000 });
    const remotes = new Map<string, string>();
    for (const line of output.split('\n')) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
      if (match?.[1] && match[2]) {
        remotes.set(match[1], match[2]);
      }
    }
    return Array.from(remotes.entries()).map(([name, url]) => ({ name, url }));
  } catch {
    return [];
  }
}
