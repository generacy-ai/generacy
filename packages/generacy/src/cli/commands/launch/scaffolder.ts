/**
 * Project directory scaffolding for `generacy launch`.
 *
 * Delegates to the shared cluster scaffolder for file writing.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { LaunchConfig } from './types.js';
import {
  scaffoldClusterJson,
  scaffoldClusterYaml,
  scaffoldDockerCompose,
} from '../cluster/scaffolder.js';

/**
 * Resolve the project directory to an absolute path.
 *
 * Default: `~/Generacy/<projectName>`. If `dirOverride` is provided it is
 * resolved relative to `cwd` (or returned as-is when already absolute).
 */
export function resolveProjectDir(projectName: string, dirOverride?: string): string {
  if (dirOverride) {
    return resolve(dirOverride);
  }
  return join(homedir(), 'Generacy', projectName);
}

/**
 * Scaffold the project directory with Generacy configuration files.
 *
 * Creates `projectDir` (recursively) if it does not exist, then writes the
 * `.generacy/` subdirectory containing `cluster.yaml`, `cluster.json`, and
 * `docker-compose.yml`.
 *
 * @throws If `.generacy/` already exists inside `projectDir`.
 */
export function scaffoldProject(projectDir: string, config: LaunchConfig): void {
  mkdirSync(projectDir, { recursive: true });

  const generacyDir = join(projectDir, '.generacy');

  if (existsSync(generacyDir)) {
    throw new Error(
      `Directory already contains a .generacy/ folder: ${generacyDir}\n` +
        '  Remove it first or choose a different --dir.',
    );
  }

  mkdirSync(generacyDir);

  scaffoldClusterJson(generacyDir, {
    cluster_id: config.clusterId,
    project_id: config.projectId,
    org_id: config.orgId,
    cloud_url: config.cloudUrl,
  });

  scaffoldClusterYaml(generacyDir, {
    channel: 'stable',
    workers: 1,
    variant: config.variant as 'cluster-base' | 'cluster-microservices',
  });

  scaffoldDockerCompose(generacyDir, {
    imageTag: config.imageTag,
    clusterId: config.clusterId,
    projectId: config.projectId,
    cloudUrl: config.cloudUrl,
    variant: config.variant as 'cluster-base' | 'cluster-microservices',
  });
}
