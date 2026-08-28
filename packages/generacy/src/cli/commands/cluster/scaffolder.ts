/**
 * Shared scaffolder for writing .generacy/ config files.
 *
 * Used by both `launch` and `deploy` commands to ensure consistent file formats.
 */
import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { getLogger } from '../../utils/logger.js';
import {
  generateGatewayToken,
  readExistingGatewayToken,
  scaffoldLlmGatewayFiles,
} from './llm-gateway.js';

export interface ScaffoldClusterJsonInput {
  cluster_id: string;
  project_id: string;
  org_id: string;
  cloud_url: string;
  display_name?: string;
}

export interface ScaffoldClusterYamlInput {
  channel?: 'stable' | 'preview';
  workers?: number;
  variant: 'cluster-base' | 'cluster-microservices';
  llmGateway?: boolean;
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
  llmGateway?: boolean;
}

export interface ScaffoldEnvInput {
  clusterId: string;
  clusterName?: string;
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
  preApprovedDeviceCode?: string;
  llmGateway?: boolean;
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
  const content: Record<string, string> = {
    cluster_id: input.cluster_id,
    project_id: input.project_id,
    org_id: input.org_id,
    cloud_url: input.cloud_url,
  };
  if (input.display_name) {
    content.display_name = input.display_name;
  }
  writeFileSync(join(dir, 'cluster.json'), JSON.stringify(content, null, 2) + '\n', 'utf-8');
}

/**
 * Write minimal cluster.yaml (channel, workers, variant only).
 */
export function scaffoldClusterYaml(dir: string, input: ScaffoldClusterYamlInput): void {
  mkdirSync(dir, { recursive: true });
  const content: Record<string, unknown> = {
    channel: input.channel ?? 'stable',
    workers: input.workers ?? 1,
    variant: input.variant,
  };
  // Persist only when enabled — omitting the key keeps existing cluster.yaml
  // output (and its golden tests) byte-identical.
  if (input.llmGateway) {
    content.llmGateway = true;
  }
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

  // Claude account config is mounted READ-ONLY as a seed, never as the live
  // file. Every container copies it to ~/.claude.json on first start (see the
  // cluster-base entrypoints) and writes only to its private copy.
  //
  // Mounting the live file was a cross-cluster hazard: every cluster on a host
  // bound the same `~/.claude.json` read-write, and `generacy setup build`
  // writes an absolute, image-flavour-specific agency CLI path into
  // `mcpServers.agency`. Whichever cluster bootstrapped last clobbered that
  // entry for every other cluster on the machine — a source-build cluster would
  // inherit a `/shared-packages/...` path that does not exist in its
  // containers, and its Agency MCP server would fail to start.
  //
  // The seed is a scaffolded, filtered copy rather than the host file itself so
  // that host-specific state (`mcpServers`, the operator's `projects` history,
  // `machineID`) never reaches a container. `bind` seeds from the host's
  // `~/.claude.json`; `volume` (deploy) ships the seed alongside the compose
  // file. The `volume` branch used to mount a named volume onto a file path,
  // which Docker rejects with "is not directory" — see #737.
  const claudeConfigVolume = './claude.json:/seed/claude.json:ro';

  // Port binding: ephemeral for local, fixed for cloud
  const orchestratorPorts =
    deploymentMode === 'cloud'
      ? ['${ORCHESTRATOR_PORT:-3100}:3100']
      : ['${ORCHESTRATOR_PORT:-3100}'];

  // Volumes mounted on both orchestrator and worker. Mirrors the canonical
  // cluster-base devcontainer compose.
  //
  // claude-config (/home/node/.claude) is a SHARED named volume so the
  // orchestrator's post-activation Claude setup — auth (`.credentials.json`),
  // speckit slash commands, and conversation history — is visible to every
  // worker. Without it, workers spawn an unauthenticated Claude CLI with no
  // speckit commands; each phase exits "Not logged in" in <1s and the phase
  // runner commits an empty phase, producing PRs with commits but no artifacts.
  // (~/.claude.json is the separate account-metadata file; both are mounted.)
  const commonVolumes = [
    claudeConfigVolume,
    'claude-config:/home/node/.claude',
    'npm-cache:/home/node/.npm',
    'generacy-data:/var/lib/generacy',
    // Shared socket dir for the git-token proxy: the orchestrator binds
    // /run/generacy-git-token/control.sock and workers connect to it for JIT
    // git tokens (generacy-ai/cluster-base#61). Must be a shared volume (not a
    // per-container tmpfs) or workers get CONTROL_SOCKET_UNREACHABLE; rw on
    // both — connecting to a Unix socket requires write access.
    'git-token-proxy:/run/generacy-git-token',
  ];

  // shared-packages MUST mount at /shared-packages — that's where the
  // cluster-base entrypoint scripts (`entrypoint-orchestrator.sh`) run
  // `npm install --prefix /shared-packages`, and the worker's entrypoint
  // resolves `/shared-packages/node_modules/.bin/generacy` to spawn the
  // worker process. Orchestrator builds here (RW); workers consume read-only.
  //
  // The orchestrator owns the `workspace` volume (RW). Workers do NOT mount it
  // at all — their per-job checkouts are container-local — so concurrent
  // workers and the orchestrator can't clobber a shared working tree.
  const orchestratorVolumes = [
    'workspace:/workspaces',
    ...commonVolumes,
    'shared-packages:/shared-packages',
    '/var/run/docker.sock:/var/run/docker-host.sock',
    'vscode-cli-state:/home/node/.vscode/cli',
    'generacy-app-config-data:/var/lib/generacy-app-config',
  ];

  const workerVolumes = [
    ...commonVolumes,
    'shared-packages:/shared-packages:ro',
    'generacy-app-config-data:/var/lib/generacy-app-config:ro',
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
          'GENERACY_INITIAL_WORKERS=${WORKER_COUNT}',
          'GENERACY_CLUSTER_ROLE=orchestrator',
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
        volumes: workerVolumes,
        tmpfs: tmpfsMounts,
        environment: [
          'REDIS_URL=redis://redis:6379',
          'REDIS_HOST=redis',
          'HEALTH_PORT=9001',
          `DEPLOYMENT_MODE=${deploymentMode}`,
          `CLUSTER_VARIANT=${variant}`,
          'GENERACY_CLUSTER_ROLE=worker',
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
      'claude-config': null,
      'git-token-proxy': null,
      'shared-packages': null,
      'npm-cache': null,
      'generacy-data': null,
      'vscode-cli-state': null,
      'redis-data': null,
      'generacy-app-config-data': null,
    },
    networks: {
      'cluster-network': {
        driver: 'bridge',
      },
    },
  };

  // Optional llm-gateway (Bifrost) sidecar. All emission is strictly behind the
  // boolean so the disabled path stays byte-identical (SC-002). Ported from
  // tetrad-development#109; deltas (cluster-network, token via .env
  // interpolation) recorded in contracts/llm-gateway-compose.yml.
  if (input.llmGateway) {
    const services = compose.services as Record<string, { environment: string[] }>;
    const gatewayEnv = [
      'GENERACY_LLM_GATEWAY_URL=http://llm-gateway:8080/anthropic',
      'GENERACY_LLM_GATEWAY_TOKEN=${GENERACY_LLM_GATEWAY_TOKEN}',
    ];
    services['orchestrator']!.environment.push(...gatewayEnv);
    services['worker']!.environment.push(...gatewayEnv);

    (compose.services as Record<string, unknown>)['llm-gateway'] = {
      image: 'maximhq/bifrost:v2.0.0',
      restart: 'unless-stopped',
      stop_grace_period: '10s',
      environment: ['GENERACY_LLM_GATEWAY_TOKEN=${GENERACY_LLM_GATEWAY_TOKEN}'],
      env_file: [{ path: '.env.local', required: false }],
      volumes: [
        'llm-gateway-data:/app/data',
        './llm-gateway/config.json:/app/data/config.json:ro',
      ],
      healthcheck: {
        test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/health'],
        interval: '30s',
        timeout: '10s',
        retries: 3,
        start_period: '45s',
      },
      networks: ['cluster-network'],
    };

    (compose.volumes as Record<string, unknown>)['llm-gateway-data'] = null;
  }

  writeFileSync(join(dir, 'docker-compose.yml'), stringify(compose), 'utf-8');

  scaffoldClaudeSeed(dir, claudeConfigMode === 'bind');

  // Gateway config + secrets files (config.example.json, config.json,
  // .gitignore, .env.local). Enabled path only; create-if-absent for the
  // operator-editable ones (T009-T011).
  if (input.llmGateway) {
    scaffoldLlmGatewayFiles(dir);
  }
}

/**
 * Keys carried from the host's `~/.claude.json` into a cluster seed.
 *
 * Deliberately excludes:
 * - `mcpServers` — absolute, image-flavour-specific paths that each container
 *   regenerates via `generacy setup build`. Copying it is what let one
 *   cluster's agency path break another's.
 * - `projects` — the operator's per-directory history, keyed by host paths that
 *   do not exist in a container (and the bulk of the file's size).
 * - `machineID` — each container should identify as itself.
 * - `cachedGrowthBookFeatures` / `cachedExperiment*` — stale caches the CLI
 *   refetches on its own.
 *
 * Auth is NOT in this file: tokens live in `~/.claude/.credentials.json`, which
 * is a separate per-cluster volume. Seeding a copy therefore cannot break login.
 */
const CLAUDE_SEED_KEYS = [
  'oauthAccount',
  'userID',
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'installMethod',
  'autoUpdates',
  'theme',
] as const;

/**
 * Build the seed contents from a host `~/.claude.json`.
 *
 * Returns an empty object when the source is missing or unreadable — a cluster
 * must still come up, it just starts from a blank account config.
 */
export function buildClaudeSeed(hostClaudeJsonPath: string): Record<string, unknown> {
  if (!existsSync(hostClaudeJsonPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(hostClaudeJsonPath, 'utf-8')) as Record<string, unknown>;
    const seed: Record<string, unknown> = {};
    for (const key of CLAUDE_SEED_KEYS) {
      if (parsed[key] !== undefined) {
        seed[key] = parsed[key];
      }
    }
    return seed;
  } catch (err) {
    getLogger().warn(
      { path: hostClaudeJsonPath, error: String(err) },
      'Could not read host ~/.claude.json; seeding an empty Claude config',
    );
    return {};
  }
}

/**
 * Write the per-cluster `claude.json` seed that containers copy on first start.
 *
 * Never overwrites an existing seed: operators may have hand-tuned it, and
 * re-seeding on every scaffold would silently revert that.
 */
export function scaffoldClaudeSeed(dir: string, fromHost: boolean): void {
  const claudeJsonPath = join(dir, 'claude.json');
  if (existsSync(claudeJsonPath)) {
    return;
  }

  const seed = fromHost ? buildClaudeSeed(join(homedir(), '.claude.json')) : {};
  writeFileSync(claudeJsonPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf-8');

  // 1000:1000 = the container's `node` user; best-effort, fails silently
  // on non-root hosts where the scaffolder user lacks CAP_CHOWN.
  try {
    chownSync(claudeJsonPath, 1000, 1000);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException | undefined)?.code;
    if (errno === 'EPERM' || errno === 'EACCES') {
      getLogger().warn(
        { path: claudeJsonPath, code: errno },
        'chown 1000:1000 on claude.json failed; continuing',
      );
    } else {
      throw err;
    }
  }
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
  const repoBranch = input.repoBranch;
  const channel = input.channel ?? 'preview';
  const workers = input.workers ?? 1;
  const port = input.orchestratorPort ?? 3100;

  const lines = [
    '# Identity (from cloud LaunchConfig — do not edit)',
    `GENERACY_CLUSTER_ID=${input.clusterId}`,
    ...(input.clusterName ? [`GENERACY_CLUSTER_NAME=${input.clusterName}`] : []),
    `GENERACY_PROJECT_ID=${input.projectId}`,
    `GENERACY_ORG_ID=${input.orgId}`,
    `GENERACY_API_URL=${apiUrl}`,
    `GENERACY_RELAY_URL=${relayUrl}`,
    '',
    '# Project',
    `PROJECT_NAME=${projectName}`,
    `REPO_URL=${repoUrl}`,
    ...(repoBranch ? [`REPO_BRANCH=${repoBranch}`] : []),
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
    ...(input.preApprovedDeviceCode
      ? [
          '# Cloud-supplied pre-approved RFC 8628 device code (single-use, short TTL).',
          '# Consumed by orchestrator activate() on first boot; never logged.',
          `GENERACY_PRE_APPROVED_DEVICE_CODE=${input.preApprovedDeviceCode}`,
          '',
        ]
      : []),
  ];

  // LLM gateway token (generate-once). An existing token is always preserved
  // verbatim — even on a disabled re-scaffold (FR-008) — so re-enabling reuses
  // it. When enabled and absent, generate one. When disabled and absent, emit
  // nothing so the disabled path stays byte-identical (SC-002).
  const envPath = join(dir, '.env');
  const existingToken = existsSync(envPath)
    ? readExistingGatewayToken(readFileSync(envPath, 'utf-8'))
    : undefined;
  const gatewayToken = existingToken ?? (input.llmGateway ? generateGatewayToken() : undefined);
  if (gatewayToken) {
    lines.push(
      '# LLM gateway (Bifrost sidecar)',
      '# Cluster-local token Claude Code presents to the gateway; generated once, never',
      '# rotated by the scaffolder. The sk-bf- prefix is REQUIRED — Bifrost 401s',
      '# unprefixed Bearer tokens.',
      `GENERACY_LLM_GATEWAY_TOKEN=${gatewayToken}`,
      '',
    );
  }

  writeFileSync(envPath, lines.join('\n'), 'utf-8');
}
