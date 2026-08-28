/**
 * Project directory scaffolding for `generacy launch`.
 *
 * Delegates to the shared cluster scaffolder for file writing.
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { LaunchConfig } from './types.js';
import {
  scaffoldClusterJson,
  scaffoldClusterYaml,
  scaffoldDockerCompose,
  scaffoldEnvFile,
} from '../cluster/scaffolder.js';
import { resolveLlmGatewayToggle } from '../cluster/llm-gateway.js';

/**
 * Pre-create ~/.claude.json if it doesn't exist.
 *
 * Docker bind mounts fail if the source file is missing. For local launch,
 * we bind-mount the host's Claude config into the container.
 */
export function preCreateClaudeJson(): void {
  const claudeJsonPath = join(homedir(), '.claude.json');
  if (!existsSync(claudeJsonPath)) {
    writeFileSync(claudeJsonPath, '{}\n', 'utf-8');
  }
}

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
 * `.generacy/` subdirectory containing `cluster.yaml`, `cluster.json`,
 * `docker-compose.yml`, and `.env`.
 *
 * @throws If `.generacy/` already exists inside `projectDir`.
 */
export function scaffoldProject(
  projectDir: string,
  config: LaunchConfig,
  workers: number,
  displayName?: string,
  llmGatewayFlag?: boolean,
): void {
  mkdirSync(projectDir, { recursive: true });

  const generacyDir = join(projectDir, '.generacy');

  if (existsSync(generacyDir)) {
    throw new Error(
      `Directory already contains a .generacy/ folder: ${generacyDir}\n` +
        '  Remove it first or choose a different --dir.',
    );
  }

  mkdirSync(generacyDir);

  // launch scaffolds a fresh .generacy/ (it throws above if one exists), so
  // there is no persisted cluster.yaml to default from — the flag and env var
  // are the only inputs here.
  const llmGateway = resolveLlmGatewayToggle({
    flag: llmGatewayFlag,
    env: process.env['GENERACY_LLM_GATEWAY_ENABLED'],
  });

  scaffoldClusterJson(generacyDir, {
    cluster_id: config.clusterId,
    project_id: config.projectId,
    org_id: config.orgId,
    cloud_url: config.cloudUrl,
    display_name: displayName,
  });

  scaffoldClusterYaml(generacyDir, {
    channel: config.channel ?? 'preview',
    workers,
    variant: config.variant as 'cluster-base' | 'cluster-microservices',
    llmGateway,
  });

  scaffoldDockerCompose(generacyDir, {
    imageTag: config.imageTag,
    clusterId: config.clusterId,
    projectId: config.projectId,
    projectName: config.projectName,
    cloudUrl: config.cloudUrl,
    variant: config.variant as 'cluster-base' | 'cluster-microservices',
    orgId: config.orgId,
    channel: config.channel ?? 'preview',
    workers,
    repoUrl: config.repos?.primary,
    claudeConfigMode: 'bind',
    llmGateway,
  });

  scaffoldEnvFile(generacyDir, {
    clusterId: config.clusterId,
    clusterName: displayName,
    projectId: config.projectId,
    orgId: config.orgId,
    cloudUrl: config.cloudUrl,
    projectName: config.projectName,
    repoUrl: config.repos?.primary,
    repoBranch: config.repos?.primaryBranch,
    channel: config.channel ?? 'preview',
    workers,
    cloud: config.cloud
      ? { apiUrl: config.cloud.apiUrl, relayUrl: config.cloud.relayUrl }
      : undefined,
    preApprovedDeviceCode: config.preApprovedDeviceCode,
    llmGateway,
  });

  preCreateClaudeJson();
}
