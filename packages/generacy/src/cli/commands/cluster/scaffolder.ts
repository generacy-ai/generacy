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
  projectName: string;
  cloudUrl: string;
  variant: 'cluster-base' | 'cluster-microservices';
  deploymentMode?: 'local' | 'cloud';
  orgId: string;
  workers?: number;
  channel?: 'stable' | 'preview';
  repoUrl?: string;
  claudeConfigMode?: 'bind' | 'volume';
}

export interface ScaffoldEnvInput {
  clusterId: string;
  projectId: string;
  orgId: string;
  cloudUrl: string;
  projectName: string;
  repoUrl?: string;
  repoBranch?: string;
  channel?: 'stable' | 'preview';
  workers?: number;
  orchestratorPort?: number;
  cloud?: { apiUrl: string; relayUrl: string };
}

/**
 * Coerce a project name into a valid Docker Compose project name.
 *
 * Compose v2 requires the name to match `^[a-z0-9][a-z0-9_-]*$`. We lowercase,
 * replace illegal characters with `-`, collapse runs, strip leading
 * non-alphanumerics, and fall back to `generacy-<clusterId-slice>` when nothing
 * usable remains.
 */
export function sanitizeComposeProjectName(name: string, clusterId: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/[-_]+$/, '')
    .slice(0, 63);
  if (cleaned && /^[a-z0-9]/.test(cleaned)) return cleaned;
  return `generacy-${clusterId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) || 'cluster'}`;
}

/**
 * Derive the WebSocket relay URL from an HTTP cloud URL.
 *
 * - `https://api.generacy.ai` → `wss://api.generacy.ai/relay?projectId=<id>`
 * - `http://localhost:3001` → `ws://localhost:3001/relay?projectId=<id>`
 */
export function deriveRelayUrl(cloudUrl: string, projectId: string): string {
  const url = new URL(cloudUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/relay';
  url.search = '';
  url.searchParams.set('projectId', projectId);
  return url.toString();
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
 * Write multi-service docker-compose.yml (orchestrator + worker + redis).
 */
export function scaffoldDockerCompose(dir: string, input: ScaffoldComposeInput): void {
  mkdirSync(dir, { recursive: true });

  const deploymentMode = input.deploymentMode ?? 'local';
  const claudeConfigMode = input.claudeConfigMode ?? 'bind';
  const variant = input.variant;

  // Claude config volume: bind mount for local, named volume for cloud
  const claudeConfigVolume =
    claudeConfigMode === 'bind'
      ? '~/.claude.json:/home/node/.claude.json'
      : 'claude-config:/home/node/.claude.json';

  // Port binding: ephemeral for local, fixed for cloud
  const orchestratorPorts =
    deploymentMode === 'cloud'
      ? ['${ORCHESTRATOR_PORT:-3100}:3100']
      : ['${ORCHESTRATOR_PORT:-3100}'];

  // Shared volumes for orchestrator and worker.
  //
  // shared-packages MUST mount at /shared-packages — that's where the
  // cluster-base entrypoint scripts (`entrypoint-orchestrator.sh`) run
  // `npm install --prefix /shared-packages`, and the worker's entrypoint
  // resolves `/shared-packages/node_modules/.bin/generacy` to spawn the
  // worker process. Mounting it anywhere else means the orchestrator's
  // install writes to its own overlay filesystem (not the volume), the
  // worker's resolve looks at its own overlay (empty), and the worker
  // exits with "Cannot find module '/shared-packages/node_modules/.bin/generacy'".
  // Matches the canonical cluster-base devcontainer compose.
  const sharedVolumes = [
    'workspace:/workspaces',
    claudeConfigVolume,
    'shared-packages:/shared-packages',
    'npm-cache:/home/node/.npm',
    'generacy-data:/var/lib/generacy',
  ];

  // Orchestrator gets docker socket
  const orchestratorVolumes = [
    ...sharedVolumes,
    '/var/run/docker.sock:/var/run/docker-host.sock',
    'vscode-cli-state:/home/node/.vscode/cli',
    'generacy-app-config-data:/var/lib/generacy-app-config',
  ];

  const tmpfsMounts = [
    '/run/generacy-credhelper:uid=1002',
    '/run/generacy-control-plane:uid=1000',
    '/run/generacy-app-config:mode=1750,uid=1000,gid=1000',
  ];

  const envFile = [
    { path: '.env' },
    { path: '.env.local', required: false },
  ];

  const compose: Record<string, unknown> = {
    name: sanitizeComposeProjectName(input.projectName, input.clusterId),
    services: {
      orchestrator: {
        image: input.imageTag,
        command: '/usr/local/bin/entrypoint-orchestrator.sh',
        restart: 'unless-stopped',
        ports: orchestratorPorts,
        volumes: orchestratorVolumes,
        tmpfs: tmpfsMounts,
        environment: [
          'REDIS_URL=redis://redis:6379',
          'REDIS_HOST=redis',
          `DEPLOYMENT_MODE=${deploymentMode}`,
          `CLUSTER_VARIANT=${variant}`,
        ],
        env_file: envFile,
        healthcheck: {
          test: ['CMD-SHELL', 'curl -f http://localhost:3100/health || exit 1'],
          interval: '10s',
          timeout: '5s',
          retries: 5,
          start_period: '30s',
        },
        depends_on: {
          redis: { condition: 'service_healthy' },
        },
        stop_grace_period: '30s',
        extra_hosts: ['host.docker.internal:host-gateway'],
        networks: ['cluster-network'],
      },
      worker: {
        image: input.imageTag,
        command: '/usr/local/bin/entrypoint-worker.sh',
        restart: 'unless-stopped',
        deploy: {
          replicas: '${WORKER_COUNT:-1}',
        },
        volumes: [...sharedVolumes, 'generacy-app-config-data:/var/lib/generacy-app-config:ro'],
        tmpfs: tmpfsMounts,
        environment: [
          'REDIS_URL=redis://redis:6379',
          'REDIS_HOST=redis',
          'HEALTH_PORT=9001',
          `DEPLOYMENT_MODE=${deploymentMode}`,
          `CLUSTER_VARIANT=${variant}`,
        ],
        env_file: envFile,
        healthcheck: {
          test: ['CMD-SHELL', 'curl -f http://localhost:9001/health || exit 1'],
          interval: '10s',
          timeout: '5s',
          retries: 5,
          start_period: '30s',
        },
        depends_on: {
          orchestrator: { condition: 'service_healthy' },
        },
        stop_grace_period: '30s',
        extra_hosts: ['host.docker.internal:host-gateway'],
        networks: ['cluster-network'],
      },
      redis: {
        image: 'redis:7-alpine',
        restart: 'unless-stopped',
        healthcheck: {
          test: ['CMD', 'redis-cli', 'ping'],
          interval: '5s',
          timeout: '3s',
          retries: 5,
        },
        volumes: ['redis-data:/data'],
        networks: ['cluster-network'],
      },
    },
    volumes: {
      workspace: null,
      'shared-packages': null,
      'npm-cache': null,
      'generacy-data': null,
      'vscode-cli-state': null,
      'redis-data': null,
      'generacy-app-config-data': null,
      ...(claudeConfigMode === 'volume' ? { 'claude-config': null } : {}),
    },
    networks: {
      'cluster-network': {
        driver: 'bridge',
      },
    },
  };

  writeFileSync(join(dir, 'docker-compose.yml'), stringify(compose), 'utf-8');
}

/**
 * Write .env file with identity vars, project vars, and runtime defaults.
 */
export function scaffoldEnvFile(dir: string, input: ScaffoldEnvInput): void {
  mkdirSync(dir, { recursive: true });

  const apiUrl = input.cloud?.apiUrl ?? input.cloudUrl;
  const relayUrl = input.cloud?.relayUrl ?? deriveRelayUrl(input.cloudUrl, input.projectId);
  const projectName = input.projectName;
  const repoUrl = input.repoUrl ?? '';
  const repoBranch = input.repoBranch ?? 'main';
  const channel = input.channel ?? 'preview';
  const workers = input.workers ?? 1;
  const port = input.orchestratorPort ?? 3100;

  const lines = [
    '# Identity (from cloud LaunchConfig — do not edit)',
    `GENERACY_CLUSTER_ID=${input.clusterId}`,
    `GENERACY_PROJECT_ID=${input.projectId}`,
    `GENERACY_ORG_ID=${input.orgId}`,
    `GENERACY_API_URL=${apiUrl}`,
    `GENERACY_RELAY_URL=${relayUrl}`,
    '',
    '# Project',
    `PROJECT_NAME=${projectName}`,
    `REPO_URL=${repoUrl}`,
    `REPO_BRANCH=${repoBranch}`,
    `GENERACY_CHANNEL=${channel}`,
    `WORKER_COUNT=${workers}`,
    '',
    '# Cluster runtime',
    `ORCHESTRATOR_PORT=${port}`,
    'LABEL_MONITOR_ENABLED=true',
    'WEBHOOK_SETUP_ENABLED=true',
    'SKIP_PACKAGE_UPDATE=false',
    'SMEE_CHANNEL_URL=',
    '',
    '# Bootstrap mode — see cluster-base entrypoint scripts',
    '# `wizard` defers repo cloning until credentials arrive via the activation wizard',
    'GENERACY_BOOTSTRAP_MODE=wizard',
    '',
  ];

  writeFileSync(join(dir, '.env'), lines.join('\n'), 'utf-8');
}
