/**
 * Worker enumeration helpers: discover the compose project name and list
 * worker replicas via the Docker Engine API.
 *
 * Extracted from worker-scaler.ts (#714) so both the scaler and the
 * orchestrator's RelayBridge can enumerate workers without dragging in the
 * scale-write paths, env-file rewriting, etc. Pure move — no behavior change.
 */

import { hostname } from 'node:os';
import { DockerEngineClient } from './docker-engine-client.js';
import type { ContainerState } from './docker-engine-types.js';

export interface WorkerReplica {
  id: string;
  number: number;
  name: string;
  state: ContainerState;
  networkIds: string[];
}

/**
 * Discover the compose project name by inspecting the orchestrator's own
 * container. Falls back to COMPOSE_PROJECT_NAME env var. Throws if neither
 * resolves — happens when running outside compose (dev mode, raw docker run).
 */
export async function computeProjectName(client: DockerEngineClient): Promise<string> {
  const selfHostname = hostname();
  try {
    const inspect = await client.inspectContainer(selfHostname);
    const project = inspect.Config.Labels?.['com.docker.compose.project'];
    if (project) return project;
  } catch {
    // Hostname may not be the container ID (e.g. when overridden in compose).
  }

  const envProject = process.env['COMPOSE_PROJECT_NAME'];
  if (envProject) return envProject;

  throw new Error('ORCHESTRATOR_NOT_COMPOSE_MANAGED');
}

/**
 * Enumerate worker containers for the given compose project. Includes
 * stopped/exited replicas. Containers with missing or non-numeric
 * `com.docker.compose.container-number` labels are skipped with a warning —
 * defensive against manually-added containers.
 */
export async function enumerateWorkers(
  client: DockerEngineClient,
  project: string,
): Promise<WorkerReplica[]> {
  const summaries = await client.listContainers({
    all: true,
    filters: {
      label: [
        `com.docker.compose.project=${project}`,
        'com.docker.compose.service=worker',
      ],
    },
  });

  const replicas: WorkerReplica[] = [];
  for (const summary of summaries) {
    const numberLabel = summary.Labels?.['com.docker.compose.container-number'];
    const parsedNumber = numberLabel ? parseInt(numberLabel, 10) : NaN;
    if (!Number.isInteger(parsedNumber) || parsedNumber < 1) {
      console.warn(
        `[worker-scaler] skipping container ${summary.Id} with missing/invalid container-number label: ${numberLabel ?? '<none>'}`,
      );
      continue;
    }
    const networkIds = summary.NetworkSettings?.Networks
      ? Object.values(summary.NetworkSettings.Networks).map((n) => n.NetworkID)
      : [];
    // `Names` arrives with a leading '/' from Engine — strip for readability.
    const rawName = summary.Names[0] ?? '';
    const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
    replicas.push({
      id: summary.Id,
      number: parsedNumber,
      name,
      state: summary.State,
      networkIds,
    });
  }

  return replicas;
}
