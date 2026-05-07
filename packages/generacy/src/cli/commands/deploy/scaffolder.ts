/**
 * Bootstrap bundle scaffolding for `generacy deploy`.
 *
 * Delegates to the shared cluster scaffolder for file writing.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LaunchConfig } from './cloud-client.js';
import type { ActivationResult } from '@generacy-ai/activation-client';
import {
  scaffoldClusterJson,
  scaffoldClusterYaml,
  scaffoldDockerCompose,
} from '../cluster/scaffolder.js';

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

  scaffoldClusterJson(generacyDir, {
    cluster_id: activation.clusterId,
    project_id: activation.projectId,
    org_id: activation.orgId,
    cloud_url: cloudUrl,
  });

  scaffoldClusterYaml(generacyDir, {
    channel: 'stable',
    workers: 1,
    variant: config.variant as 'cluster-base' | 'cluster-microservices',
  });

  scaffoldDockerCompose(tmpDir, {
    imageTag: config.imageTag,
    clusterId: activation.clusterId,
    projectId: activation.projectId,
    projectName: config.projectName,
    cloudUrl,
    variant: config.variant as 'cluster-base' | 'cluster-microservices',
    deploymentMode: 'cloud',
  });

  return tmpDir;
}
