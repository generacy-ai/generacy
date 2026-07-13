import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock chownSync so the chown-failure test can drive it. Default is a no-op,
// so the rest of the scaffolder tests are unaffected (their flows do not
// depend on chownSync behavior).
const { chownMock } = vi.hoisted(() => ({ chownMock: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, chownSync: chownMock };
});

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import {
  scaffoldClusterJson,
  scaffoldClusterYaml,
  scaffoldDockerCompose,
  scaffoldEnvFile,
  deriveRelayUrl,
  sanitizeComposeProjectName,
} from '../scaffolder.js';
import { getLogger } from '../../../utils/logger.js';

describe('scaffoldClusterJson', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scaffolder-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes snake_case fields', () => {
    scaffoldClusterJson(dir, {
      cluster_id: 'clust_abc',
      project_id: 'proj_def',
      org_id: 'org_ghi',
      cloud_url: 'https://api.generacy.ai',
    });

    const raw = readFileSync(join(dir, 'cluster.json'), 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed).toEqual({
      cluster_id: 'clust_abc',
      project_id: 'proj_def',
      org_id: 'org_ghi',
      cloud_url: 'https://api.generacy.ai',
    });
  });

  it('does not include camelCase fields', () => {
    scaffoldClusterJson(dir, {
      cluster_id: 'clust_abc',
      project_id: 'proj_def',
      org_id: 'org_ghi',
      cloud_url: 'https://api.generacy.ai',
    });

    const raw = readFileSync(join(dir, 'cluster.json'), 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed).not.toHaveProperty('clusterId');
    expect(parsed).not.toHaveProperty('projectId');
    expect(parsed).not.toHaveProperty('orgId');
    expect(parsed).not.toHaveProperty('cloudUrl');
    expect(parsed).not.toHaveProperty('projectName');
    expect(parsed).not.toHaveProperty('imageTag');
    expect(parsed).not.toHaveProperty('createdAt');
  });

  it('persists display_name when provided (SC-001)', async () => {
    // Integration: simulates `generacy launch --name "ACME Frontend"` — the
    // launch command normalizes the user input via normalizeClusterName,
    // threads it through scaffoldClusterJson + scaffoldEnvFile, and the
    // resulting files surface the user-facing name.
    const { normalizeClusterName } = await import('../name-normalize.js');
    const displayName = normalizeClusterName('ACME Frontend');
    expect(displayName).toBe('acme-frontend');

    scaffoldClusterJson(dir, {
      cluster_id: 'cid-1',
      project_id: 'proj-1',
      org_id: 'org-1',
      cloud_url: 'https://api.generacy.ai',
      display_name: displayName!,
    });

    scaffoldEnvFile(dir, {
      clusterId: 'cid-1',
      projectId: 'proj-1',
      orgId: 'org-1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'ACME Frontend',
      clusterName: displayName!,
    });

    const clusterJson = JSON.parse(readFileSync(join(dir, 'cluster.json'), 'utf-8'));
    expect(clusterJson.display_name).toBe('acme-frontend');

    const envContent = readFileSync(join(dir, '.env'), 'utf-8');
    expect(envContent).toContain('GENERACY_CLUSTER_NAME=acme-frontend');
  });
});

describe('scaffoldClusterYaml', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scaffolder-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes only channel, workers, variant', () => {
    scaffoldClusterYaml(dir, { variant: 'cluster-base' });

    const raw = readFileSync(join(dir, 'cluster.yaml'), 'utf-8');
    const parsed = parse(raw);

    expect(parsed).toEqual({
      channel: 'stable',
      workers: 1,
      variant: 'cluster-base',
    });
  });

  it('does not include imageTag, cloudUrl, or ports', () => {
    scaffoldClusterYaml(dir, { variant: 'cluster-microservices', channel: 'preview', workers: 2 });

    const raw = readFileSync(join(dir, 'cluster.yaml'), 'utf-8');
    const parsed = parse(raw);

    expect(parsed).not.toHaveProperty('imageTag');
    expect(parsed).not.toHaveProperty('cloudUrl');
    expect(parsed).not.toHaveProperty('ports');
    expect(parsed).toEqual({
      channel: 'preview',
      workers: 2,
      variant: 'cluster-microservices',
    });
  });

  it('accepts cluster-base and cluster-microservices variants', () => {
    scaffoldClusterYaml(dir, { variant: 'cluster-base' });
    const raw1 = readFileSync(join(dir, 'cluster.yaml'), 'utf-8');
    expect(parse(raw1).variant).toBe('cluster-base');

    scaffoldClusterYaml(dir, { variant: 'cluster-microservices' });
    const raw2 = readFileSync(join(dir, 'cluster.yaml'), 'utf-8');
    expect(parse(raw2).variant).toBe('cluster-microservices');
  });
});

describe('scaffoldDockerCompose', () => {
  let dir: string;

  const baseInput = {
    imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
    clusterId: 'clust_abc',
    projectId: 'proj_def',
    projectName: 'todo-list-example',
    cloudUrl: 'https://api.generacy.ai',
    variant: 'cluster-base' as const,
    orgId: 'org_xyz',
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scaffolder-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits three services: orchestrator, worker, redis', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(Object.keys(parsed.services)).toEqual(['orchestrator', 'worker', 'redis']);
    expect(parsed.services).not.toHaveProperty('cluster');
  });

  it('sets correct command overrides for orchestrator and worker', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.command).toBe('/usr/local/bin/entrypoint-orchestrator.sh');
    expect(parsed.services.worker.command).toBe('/usr/local/bin/entrypoint-worker.sh');
  });

  it('sets correct image for orchestrator and worker', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.image).toBe('ghcr.io/generacy-ai/cluster-base:1.5.0');
    expect(parsed.services.worker.image).toBe('ghcr.io/generacy-ai/cluster-base:1.5.0');
    expect(parsed.services.redis.image).toBe('redis:7-alpine');
  });

  it('mounts docker socket at /var/run/docker-host.sock on orchestrator only', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const orchVolumes = parsed.services.orchestrator.volumes as string[];
    expect(orchVolumes).toContain('/var/run/docker.sock:/var/run/docker-host.sock');

    const workerVolumes = parsed.services.worker.volumes as string[];
    expect(workerVolumes.join(',')).not.toContain('docker');
  });

  it('mounts vscode-cli volume on orchestrator only', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const orchVolumes = parsed.services.orchestrator.volumes as string[];
    expect(orchVolumes).toContain('vscode-cli-state:/home/node/.vscode/cli');

    const workerVolumes = parsed.services.worker.volumes as string[];
    expect(workerVolumes).not.toContain('vscode-cli-state:/home/node/.vscode/cli');
  });

  it('includes tmpfs mounts on orchestrator and worker', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.tmpfs).toContain('/run/generacy-credhelper:uid=1002');
    expect(parsed.services.orchestrator.tmpfs).toContain('/run/generacy-control-plane:uid=1000');
    expect(parsed.services.orchestrator.tmpfs).toContain('/run/generacy-app-config:mode=1750,uid=1000,gid=1000');
    expect(parsed.services.worker.tmpfs).toContain('/run/generacy-credhelper:uid=1002');
    expect(parsed.services.worker.tmpfs).toContain('/run/generacy-control-plane:uid=1000');
    expect(parsed.services.worker.tmpfs).toContain('/run/generacy-app-config:mode=1750,uid=1000,gid=1000');
  });

  it('includes healthchecks for all services', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.healthcheck.test).toContain('curl -f http://localhost:3100/health || exit 1');
    expect(parsed.services.worker.healthcheck.test).toContain('curl -f http://localhost:9001/health || exit 1');
    expect(parsed.services.redis.healthcheck.test).toEqual(['CMD', 'redis-cli', 'ping']);
  });

  it('includes depends_on chain: worker→orchestrator→redis', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.depends_on.redis.condition).toBe('service_healthy');
    expect(parsed.services.worker.depends_on.orchestrator.condition).toBe('service_healthy');
  });

  it('includes env_file references', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const orchEnvFile = parsed.services.orchestrator.env_file;
    expect(orchEnvFile[0]).toEqual({ path: '.env' });
    expect(orchEnvFile[1]).toEqual({ path: '.env.local', required: false });
  });

  it('includes cluster-network on all services', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.networks).toContain('cluster-network');
    expect(parsed.services.worker.networks).toContain('cluster-network');
    expect(parsed.services.redis.networks).toContain('cluster-network');
    expect(parsed.networks['cluster-network'].driver).toBe('bridge');
  });

  it('includes stop_grace_period on orchestrator and worker', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.stop_grace_period).toBe('30s');
    expect(parsed.services.worker.stop_grace_period).toBe('30s');
  });

  it('includes extra_hosts on orchestrator and worker', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.extra_hosts).toContain('host.docker.internal:host-gateway');
    expect(parsed.services.worker.extra_hosts).toContain('host.docker.internal:host-gateway');
  });

  it('local mode (default) emits ephemeral port for orchestrator', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.ports).toEqual(['${ORCHESTRATOR_PORT:-3100}']);
  });

  it('cloud mode emits fixed port binding for orchestrator', () => {
    scaffoldDockerCompose(dir, { ...baseInput, deploymentMode: 'cloud' });
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.ports).toEqual(['${ORCHESTRATOR_PORT:-3100}:3100']);
  });

  it('worker has no ports', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.worker).not.toHaveProperty('ports');
  });

  it('bind mode binds ~/.claude.json and shares the claude-config dir volume', () => {
    scaffoldDockerCompose(dir, { ...baseInput, claudeConfigMode: 'bind' });
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const orchVolumes = parsed.services.orchestrator.volumes as string[];
    const workerVolumes = parsed.services.worker.volumes as string[];
    // ~/.claude.json is bind-mounted (account metadata file).
    expect(orchVolumes).toContain('~/.claude.json:/home/node/.claude.json');
    // The .claude DIRECTORY is a shared named volume so workers inherit the
    // orchestrator's Claude auth + speckit commands + conversations.
    expect(orchVolumes).toContain('claude-config:/home/node/.claude');
    expect(workerVolumes).toContain('claude-config:/home/node/.claude');
    expect(parsed.volumes).toHaveProperty('claude-config');
    // #737 guard: never mount the named volume onto the .claude.json FILE path
    // (Docker rejects "is not directory").
    expect(orchVolumes).not.toContain('claude-config:/home/node/.claude.json');
    expect(workerVolumes).not.toContain('claude-config:/home/node/.claude.json');
  });

  // T001 [US2]: lock SC-002 — bind-mode YAML must be byte-identical after the
  // volume-mode fix lands. Snapshot is written on first run and committed; any
  // future change to the bind branch will trip this test.
  it('bind mode emits byte-identical YAML (SC-002 regression guard)', () => {
    scaffoldDockerCompose(dir, { ...baseInput, claudeConfigMode: 'bind' });
    const raw = readFileSync(join(dir, 'docker-compose.yml'), 'utf-8');
    expect(raw).toMatchSnapshot();
  });

  // T002 [US1]: volume-mode contract per scaffolder-volume-mode.md Q2–Q5.
  it('volume mode mounts ./claude.json on both orchestrator and worker (no named volume)', () => {
    scaffoldDockerCompose(dir, { ...baseInput, claudeConfigMode: 'volume' });
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const orchVolumes = parsed.services.orchestrator.volumes as string[];
    const workerVolumes = parsed.services.worker.volumes as string[];

    expect(orchVolumes).toContain('./claude.json:/home/node/.claude.json');
    expect(workerVolumes).toContain('./claude.json:/home/node/.claude.json');
    // #737 guard: the named volume must never mount onto the .claude.json FILE.
    expect(orchVolumes).not.toContain('claude-config:/home/node/.claude.json');
    expect(workerVolumes).not.toContain('claude-config:/home/node/.claude.json');
    // …but the .claude DIRECTORY is still a shared named volume on both.
    expect(orchVolumes).toContain('claude-config:/home/node/.claude');
    expect(workerVolumes).toContain('claude-config:/home/node/.claude');
    expect(parsed.volumes).toHaveProperty('claude-config');
  });

  // T003 [US1]: idempotency per contract Q6–Q8 / FR-002, FR-003.
  it('volume mode creates claude.json with "{}\\n" when it does not exist', () => {
    scaffoldDockerCompose(dir, { ...baseInput, claudeConfigMode: 'volume' });
    const path = join(dir, 'claude.json');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('{}\n');
  });

  it('volume mode preserves pre-existing claude.json bytes and mtime', async () => {
    const path = join(dir, 'claude.json');
    const original = '{"token":"sk-existing","other":42}\n';
    writeFileSync(path, original, 'utf-8');
    const before = statSync(path);
    // Ensure a measurable delay so any rewrite would change mtime.
    await new Promise((r) => setTimeout(r, 20));

    scaffoldDockerCompose(dir, { ...baseInput, claudeConfigMode: 'volume' });

    const after = statSync(path);
    expect(readFileSync(path, 'utf-8')).toBe(original);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  // T004 [P] [US1]: chown failure path per FR-004, FR-008.
  it('volume mode logs a warning and continues when chown fails with EPERM', () => {
    const logger = getLogger();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    chownMock.mockImplementationOnce(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    try {
      expect(() =>
        scaffoldDockerCompose(dir, { ...baseInput, claudeConfigMode: 'volume' }),
      ).not.toThrow();

      const path = join(dir, 'claude.json');
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf-8')).toBe('{}\n');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const call = warnSpy.mock.calls[0]!;
      // Logger may be called as warn(obj, msg) or warn(msg) — assert path appears somewhere.
      const serialized = JSON.stringify(call);
      expect(serialized).toContain('claude.json');
      expect(serialized).toContain('EPERM');
    } finally {
      warnSpy.mockRestore();
      chownMock.mockReset();
    }
  });

  it('includes DEPLOYMENT_MODE and CLUSTER_VARIANT in environment', () => {
    scaffoldDockerCompose(dir, { ...baseInput, deploymentMode: 'cloud' });
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.environment).toContain('DEPLOYMENT_MODE=cloud');
    expect(parsed.services.orchestrator.environment).toContain('CLUSTER_VARIANT=cluster-base');
    expect(parsed.services.worker.environment).toContain('DEPLOYMENT_MODE=cloud');
    expect(parsed.services.worker.environment).toContain('CLUSTER_VARIANT=cluster-base');
  });

  it('includes GENERACY_INITIAL_WORKERS interpolated from WORKER_COUNT on orchestrator only', () => {
    scaffoldDockerCompose(dir, baseInput);
    const raw = readFileSync(join(dir, 'docker-compose.yml'), 'utf-8');
    const parsed = parse(raw);

    expect(parsed.services.orchestrator.environment).toContain(
      'GENERACY_INITIAL_WORKERS=${WORKER_COUNT}',
    );
    expect(parsed.services.worker.environment).not.toContain(
      'GENERACY_INITIAL_WORKERS=${WORKER_COUNT}',
    );
    expect(raw).toContain('GENERACY_INITIAL_WORKERS=${WORKER_COUNT}');
  });

  it('includes worker deploy.replicas', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.worker.deploy.replicas).toBe('${WORKER_COUNT:-1}');
  });

  it('mounts app-config-data volume rw on orchestrator', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const orchVolumes = parsed.services.orchestrator.volumes as string[];
    expect(orchVolumes).toContain('generacy-app-config-data:/var/lib/generacy-app-config');
  });

  it('mounts app-config-data volume ro on worker', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const workerVolumes = parsed.services.worker.volumes as string[];
    expect(workerVolumes).toContain('generacy-app-config-data:/var/lib/generacy-app-config:ro');
    expect(workerVolumes).not.toContain('generacy-app-config-data:/var/lib/generacy-app-config');
  });

  it('declares all expected named volumes', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.volumes).toHaveProperty('workspace');
    expect(parsed.volumes).toHaveProperty('claude-config');
    expect(parsed.volumes).toHaveProperty('shared-packages');
    expect(parsed.volumes).toHaveProperty('npm-cache');
    expect(parsed.volumes).toHaveProperty('generacy-data');
    expect(parsed.volumes).toHaveProperty('redis-data');
    expect(parsed.volumes).toHaveProperty('vscode-cli-state');
    expect(parsed.volumes).toHaveProperty('generacy-app-config-data');
  });

  it('mounts workspace on the orchestrator only — workers do not share it', () => {
    // Workers must not share the orchestrator's working tree (concurrent
    // checkouts would clobber it); their per-job checkouts are container-local.
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.volumes).toContain('workspace:/workspaces');
    const workerVolumes = parsed.services.worker.volumes as string[];
    expect(workerVolumes.some((v) => v.startsWith('workspace:'))).toBe(false);
  });

  it('shares the git-token-proxy socket volume on both orchestrator and worker', () => {
    // The orchestrator binds /run/generacy-git-token/control.sock and workers
    // connect to it for JIT git tokens (cluster-base#61). It must be a shared
    // named volume on BOTH services (rw — Unix socket connect needs write) or
    // workers get CONTROL_SOCKET_UNREACHABLE and can't authenticate git.
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const mount = 'git-token-proxy:/run/generacy-git-token';
    expect(parsed.services.orchestrator.volumes).toContain(mount);
    expect(parsed.services.worker.volumes).toContain(mount);
    expect(parsed.volumes).toHaveProperty('git-token-proxy');
  });

  it('mounts shared-packages at /shared-packages (cluster-base entrypoint contract)', () => {
    // The cluster-base entrypoint scripts (`entrypoint-orchestrator.sh`,
    // `entrypoint-worker.sh`) run `npm install --prefix /shared-packages`
    // and resolve `/shared-packages/node_modules/.bin/generacy`. The volume
    // MUST mount at that exact path on both services — mounting it elsewhere
    // means orchestrator and worker each install/resolve against their own
    // empty overlay filesystem, and the worker exits with MODULE_NOT_FOUND.
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.volumes).toContain('shared-packages:/shared-packages');
    // Worker consumes the orchestrator's build output read-only.
    expect(parsed.services.worker.volumes).toContain('shared-packages:/shared-packages:ro');
  });

  it('sanitizes project name', () => {
    scaffoldDockerCompose(dir, { ...baseInput, projectName: 'My Awesome Project!' });
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.name).toBe('my-awesome-project');
  });
});

describe('scaffoldEnvFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scaffolder-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes .env with all expected variables', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'clust_abc',
      projectId: 'proj_def',
      orgId: 'org_ghi',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'my-project',
      repoUrl: 'https://github.com/org/repo',
      channel: 'preview',
      workers: 2,
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');

    expect(content).toContain('GENERACY_CLUSTER_ID=clust_abc');
    expect(content).toContain('GENERACY_PROJECT_ID=proj_def');
    expect(content).toContain('GENERACY_ORG_ID=org_ghi');
    expect(content).toContain('PROJECT_NAME=my-project');
    expect(content).toContain('REPO_URL=https://github.com/org/repo');
    expect(content).not.toContain('REPO_BRANCH=');
    expect(content).toContain('GENERACY_CHANNEL=preview');
    expect(content).toContain('WORKER_COUNT=2');
    expect(content).toContain('ORCHESTRATOR_PORT=3100');
    expect(content).toContain('LABEL_MONITOR_ENABLED=true');
    expect(content).toContain('WEBHOOK_SETUP_ENABLED=true');
    expect(content).toContain('SKIP_PACKAGE_UPDATE=false');
    expect(content).toContain('SMEE_CHANNEL_URL=');
    expect(content).toContain('GENERACY_BOOTSTRAP_MODE=wizard');
  });

  it('writes GENERACY_API_URL and GENERACY_RELAY_URL (not GENERACY_CLOUD_URL)', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).toContain('GENERACY_API_URL=https://api.generacy.ai');
    expect(content).toContain('GENERACY_RELAY_URL=wss://api.generacy.ai/relay?projectId=p1');
    expect(content).not.toContain('GENERACY_CLOUD_URL');
  });

  it('with cloud object, values come directly from cloud', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
      cloud: {
        apiUrl: 'https://api-staging.generacy.ai',
        relayUrl: 'wss://api-staging.generacy.ai/relay?projectId=p1',
      },
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).toContain('GENERACY_API_URL=https://api-staging.generacy.ai');
    expect(content).toContain('GENERACY_RELAY_URL=wss://api-staging.generacy.ai/relay?projectId=p1');
    expect(content).not.toContain('GENERACY_CLOUD_URL');
  });

  it('without cloud object, GENERACY_API_URL from cloudUrl, GENERACY_RELAY_URL derived', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).toContain('GENERACY_API_URL=https://api.generacy.ai');
    expect(content).toContain('GENERACY_RELAY_URL=wss://api.generacy.ai/relay?projectId=p1');
  });

  it('omits REPO_BRANCH when repoBranch is not provided', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
      repoUrl: 'https://github.com/org/repo',
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).not.toContain('REPO_BRANCH=');
  });

  it('writes REPO_BRANCH when repoBranch is explicitly set to develop', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
      repoBranch: 'develop',
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).toContain('REPO_BRANCH=develop');
  });

  it('writes REPO_BRANCH when repoBranch is explicitly set to main (opt-in)', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
      repoBranch: 'main',
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).toContain('REPO_BRANCH=main');
  });

  it('writes the supplied workers value into WORKER_COUNT=', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'demo',
      workers: 4,
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).toContain('WORKER_COUNT=4');
  });

  it('uses default values when optionals are omitted', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).toContain('REPO_URL=');
    expect(content).not.toContain('REPO_BRANCH=');
    expect(content).toContain('GENERACY_CHANNEL=preview');
    expect(content).toContain('WORKER_COUNT=1');
    expect(content).toContain('ORCHESTRATOR_PORT=3100');
  });

  it('emits GENERACY_PRE_APPROVED_DEVICE_CODE line when preApprovedDeviceCode is set', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
      preApprovedDeviceCode: 'ABCD-1234',
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).toContain('GENERACY_PRE_APPROVED_DEVICE_CODE=ABCD-1234');
    expect(content).toContain(
      '# Cloud-supplied pre-approved RFC 8628 device code (single-use, short TTL).',
    );
    expect(content).toContain(
      '# Consumed by orchestrator activate() on first boot; never logged.',
    );
  });

  it('omits GENERACY_PRE_APPROVED_DEVICE_CODE line when preApprovedDeviceCode is unset', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).not.toContain('GENERACY_PRE_APPROVED_DEVICE_CODE');
  });

  it('treats empty string preApprovedDeviceCode as absent', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
      preApprovedDeviceCode: '',
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).not.toContain('GENERACY_PRE_APPROVED_DEVICE_CODE');
  });

  // #878: CLUSTER_ACTING_LOGIN is dissolved. The generated .env must never
  // reference the var — the mechanism it fed (`cluster-identity` trust rule)
  // is replaced by GraphQL's `viewerDidAuthor` primitive.
  it('never emits CLUSTER_ACTING_LOGIN in the generated .env (#878)', () => {
    scaffoldEnvFile(dir, {
      clusterId: 'c1',
      projectId: 'p1',
      orgId: 'o1',
      cloudUrl: 'https://api.generacy.ai',
      projectName: 'test',
    });

    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).not.toContain('CLUSTER_ACTING_LOGIN');
  });
});

describe('deriveRelayUrl', () => {
  it('converts https to wss', () => {
    expect(deriveRelayUrl('https://api.generacy.ai', 'proj1')).toBe(
      'wss://api.generacy.ai/relay?projectId=proj1',
    );
  });

  it('converts http to ws', () => {
    expect(deriveRelayUrl('http://localhost:3001', 'proj1')).toBe(
      'ws://localhost:3001/relay?projectId=proj1',
    );
  });

  it('handles trailing slash in input', () => {
    expect(deriveRelayUrl('https://api.generacy.ai/', 'proj1')).toBe(
      'wss://api.generacy.ai/relay?projectId=proj1',
    );
  });

  it('handles input with existing path (overrides it)', () => {
    expect(deriveRelayUrl('https://api.generacy.ai/v1/some-path', 'proj1')).toBe(
      'wss://api.generacy.ai/relay?projectId=proj1',
    );
  });

  it('preserves port in localhost URLs', () => {
    expect(deriveRelayUrl('http://localhost:4000', 'p2')).toBe(
      'ws://localhost:4000/relay?projectId=p2',
    );
  });

  it('handles staging URLs', () => {
    expect(deriveRelayUrl('https://api-staging.generacy.ai', 'proj_stg')).toBe(
      'wss://api-staging.generacy.ai/relay?projectId=proj_stg',
    );
  });
});

describe('sanitizeComposeProjectName', () => {
  it('lowercases and replaces illegal characters with hyphens', () => {
    expect(sanitizeComposeProjectName('My Project!', 'clust_abc')).toBe('my-project');
  });

  it('preserves leading digits (they are valid)', () => {
    expect(sanitizeComposeProjectName('123-project', 'clust_abc')).toBe('123-project');
  });

  it('strips leading hyphens and underscores', () => {
    expect(sanitizeComposeProjectName('--foo-bar', 'clust_abc')).toBe('foo-bar');
    expect(sanitizeComposeProjectName('__foo', 'clust_abc')).toBe('foo');
  });

  it('collapses runs of hyphens', () => {
    expect(sanitizeComposeProjectName('foo----bar', 'clust_abc')).toBe('foo-bar');
  });

  it('falls back to a clusterId-derived name when nothing usable remains', () => {
    expect(sanitizeComposeProjectName('!!!', 'clust_abc123')).toBe('generacy-clustabc123');
    expect(sanitizeComposeProjectName('', 'XYZ-789')).toBe('generacy-xyz789');
    expect(sanitizeComposeProjectName('!!!', '')).toBe('generacy-cluster');
  });

  it('truncates to 63 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeComposeProjectName(long, 'clust_abc').length).toBe(63);
  });
});
