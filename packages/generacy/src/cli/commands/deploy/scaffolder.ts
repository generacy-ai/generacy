import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import type { LaunchConfig } from './cloud-client.js';
import type { ActivationResult } from '@generacy-ai/activation-client';

/**
 * Generate bootstrap bundle files in a temp directory.
 * Returns the path to the temp directory.
 */
export function scaffoldBundle(
  config: LaunchConfig,
  activation: ActivationResult,
  cloudUrl: string,
): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'generacy-deploy-'));
  const generacyDir = join(tmpDir, '.generacy');
  mkdirSync(generacyDir);

  // cluster.yaml
  const clusterYaml = {
    variant: config.variant,
    imageTag: config.imageTag,
    cloudUrl,
    ports: {
      orchestrator: 3100,
      relay: 3101,
      controlPlane: 3102,
    },
  };
  writeFileSync(join(generacyDir, 'cluster.yaml'), stringify(clusterYaml), 'utf-8');

  // cluster.json
  const clusterJson = {
    clusterId: activation.clusterId,
    projectId: activation.projectId,
    projectName: config.projectName,
    variant: config.variant,
    cloudUrl,
    imageTag: config.imageTag,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(
    join(generacyDir, 'cluster.json'),
    JSON.stringify(clusterJson, null, 2) + '\n',
    'utf-8',
  );

  // docker-compose.yml
  const compose = {
    version: '3.8',
    services: {
      cluster: {
        image: config.imageTag,
        container_name: `generacy-cluster-${activation.clusterId}`,
        restart: 'unless-stopped',
        ports: ['3100:3100', '3101:3101', '3102:3102'],
        volumes: [
          'cluster-data:/var/lib/generacy',
          '/var/run/docker.sock:/var/run/docker.sock',
        ],
        environment: [
          `GENERACY_CLOUD_URL=${cloudUrl}`,
          `GENERACY_CLUSTER_ID=${activation.clusterId}`,
          `GENERACY_PROJECT_ID=${activation.projectId}`,
        ],
      },
    },
    volumes: {
      'cluster-data': null,
    },
  };
  writeFileSync(join(tmpDir, 'docker-compose.yml'), stringify(compose), 'utf-8');

  return tmpDir;
}
