/**
 * Shared scaffolder for writing .generacy/ config files.
 *
 * Used by both `launch` and `deploy` commands to ensure consistent file formats.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

export interface ScaffoldClusterJsonInput {
  cluster_id: string;
  project_id: string;
  org_id: string;
  cloud_url: string;
}

export interface ScaffoldClusterYamlInput {
  channel?: 'stable' | 'preview';
  workers?: number;
  variant: 'cluster-base' | 'cluster-microservices';
}

export interface ScaffoldComposeInput {
  imageTag: string;
  clusterId: string;
  projectId: string;
  cloudUrl: string;
  variant: 'cluster-base' | 'cluster-microservices';
  deploymentMode?: 'local' | 'cloud';
}

/**
 * Write snake_case cluster.json to the given directory.
 */
export function scaffoldClusterJson(dir: string, input: ScaffoldClusterJsonInput): void {
  mkdirSync(dir, { recursive: true });
  const content = {
    cluster_id: input.cluster_id,
    project_id: input.project_id,
    org_id: input.org_id,
    cloud_url: input.cloud_url,
  };
  writeFileSync(join(dir, 'cluster.json'), JSON.stringify(content, null, 2) + '\n', 'utf-8');
}

/**
 * Write minimal cluster.yaml (channel, workers, variant only).
 */
export function scaffoldClusterYaml(dir: string, input: ScaffoldClusterYamlInput): void {
  mkdirSync(dir, { recursive: true });
  const content = {
    channel: input.channel ?? 'stable',
    workers: input.workers ?? 1,
    variant: input.variant,
  };
  writeFileSync(join(dir, 'cluster.yaml'), stringify(content), 'utf-8');
}

/**
 * Write docker-compose.yml with image, ports, env, volumes.
 */
export function scaffoldDockerCompose(dir: string, input: ScaffoldComposeInput): void {
  mkdirSync(dir, { recursive: true });
  const compose = {
    version: '3.8',
    services: {
      cluster: {
        image: input.imageTag,
        container_name: `generacy-cluster-${input.clusterId}`,
        restart: 'unless-stopped',
        ports: ['3100:3100', '3101:3101', '3102:3102'],
        volumes: [
          'cluster-data:/var/lib/generacy',
          '/var/run/docker.sock:/var/run/docker.sock',
        ],
        environment: [
          `GENERACY_CLOUD_URL=${input.cloudUrl}`,
          `GENERACY_CLUSTER_ID=${input.clusterId}`,
          `GENERACY_PROJECT_ID=${input.projectId}`,
          `DEPLOYMENT_MODE=${input.deploymentMode ?? 'local'}`,
          `CLUSTER_VARIANT=${input.variant}`,
        ],
      },
    },
    volumes: {
      'cluster-data': null,
    },
  };
  writeFileSync(join(dir, 'docker-compose.yml'), stringify(compose), 'utf-8');
}
