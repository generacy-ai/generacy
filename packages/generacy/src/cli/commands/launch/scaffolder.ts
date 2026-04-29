/**
 * Project directory scaffolding for `generacy launch`.
 *
 * Creates the `.generacy/` config directory and writes:
 *   - cluster.yaml   — runtime cluster config
 *   - cluster.json   — machine-readable metadata
 *   - docker-compose.yml — Compose service definition
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { stringify } from 'yaml';
import type { LaunchConfig, ClusterYaml, ClusterMetadata } from './types.js';

/**
 * Resolve the project directory to an absolute path.
 *
 * Default: `~/Generacy/<projectName>`. If `dirOverride` is provided it is
 * resolved relative to `cwd` (or returned as-is when already absolute).
 *
 * @param projectName - Human-readable project name from the launch config.
 * @param dirOverride - Optional explicit directory supplied via `--dir`.
 * @returns Absolute path to the project directory.
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
 * @param projectDir - Absolute path to the project directory.
 * @param config - Launch configuration received from the cloud API.
 * @throws If `.generacy/` already exists inside `projectDir`.
 */
export function scaffoldProject(projectDir: string, config: LaunchConfig): void {
  // Ensure the project directory exists.
  mkdirSync(projectDir, { recursive: true });

  const generacyDir = join(projectDir, '.generacy');

  // Fail if .generacy/ already exists — prevents accidental overwrites.
  if (existsSync(generacyDir)) {
    throw new Error(
      `Directory already contains a .generacy/ folder: ${generacyDir}\n` +
        '  Remove it first or choose a different --dir.',
    );
  }

  mkdirSync(generacyDir);

  // ── cluster.yaml ────────────────────────────────────────────────────
  const clusterYaml: ClusterYaml = {
    variant: config.variant,
    imageTag: config.imageTag,
    cloudUrl: config.cloudUrl,
    ports: {
      orchestrator: 3100,
      relay: 3101,
      controlPlane: 3102,
    },
  };
  writeFileSync(join(generacyDir, 'cluster.yaml'), stringify(clusterYaml), 'utf-8');

  // ── cluster.json ────────────────────────────────────────────────────
  const clusterMetadata: ClusterMetadata = {
    clusterId: config.clusterId,
    projectId: config.projectId,
    projectName: config.projectName,
    variant: config.variant,
    cloudUrl: config.cloudUrl,
    imageTag: config.imageTag,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(
    join(generacyDir, 'cluster.json'),
    JSON.stringify(clusterMetadata, null, 2) + '\n',
    'utf-8',
  );

  // ── docker-compose.yml ──────────────────────────────────────────────
  const compose = {
    version: '3.8',
    services: {
      cluster: {
        image: config.imageTag,
        container_name: `generacy-cluster-${config.clusterId}`,
        restart: 'unless-stopped',
        ports: ['3100:3100', '3101:3101', '3102:3102'],
        volumes: [
          'cluster-data:/var/lib/generacy',
          '/var/run/docker.sock:/var/run/docker.sock',
        ],
        environment: [
          `GENERACY_CLOUD_URL=${config.cloudUrl}`,
          `GENERACY_CLUSTER_ID=${config.clusterId}`,
          `GENERACY_PROJECT_ID=${config.projectId}`,
        ],
      },
    },
    volumes: {
      'cluster-data': null,
    },
  };
  writeFileSync(join(generacyDir, 'docker-compose.yml'), stringify(compose), 'utf-8');
}
