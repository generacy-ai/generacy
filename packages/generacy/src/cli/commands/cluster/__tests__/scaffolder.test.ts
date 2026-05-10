import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it('includes tmpfs mounts on orchestrator and worker', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.tmpfs).toContain('/run/generacy-credhelper:uid=1002');
    expect(parsed.services.orchestrator.tmpfs).toContain('/run/generacy-control-plane:uid=1000');
    expect(parsed.services.worker.tmpfs).toContain('/run/generacy-credhelper:uid=1002');
    expect(parsed.services.worker.tmpfs).toContain('/run/generacy-control-plane:uid=1000');
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

  it('bind mode uses ~/.claude.json bind mount (no claude-config volume)', () => {
    scaffoldDockerCompose(dir, { ...baseInput, claudeConfigMode: 'bind' });
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const orchVolumes = parsed.services.orchestrator.volumes as string[];
    expect(orchVolumes).toContain('~/.claude.json:/home/node/.claude.json');
    expect(parsed.volumes).not.toHaveProperty('claude-config');
  });

  it('volume mode uses claude-config named volume', () => {
    scaffoldDockerCompose(dir, { ...baseInput, claudeConfigMode: 'volume' });
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const orchVolumes = parsed.services.orchestrator.volumes as string[];
    expect(orchVolumes).toContain('claude-config:/home/node/.claude.json');
    expect(parsed.volumes).toHaveProperty('claude-config');
  });

  it('includes DEPLOYMENT_MODE and CLUSTER_VARIANT in environment', () => {
    scaffoldDockerCompose(dir, { ...baseInput, deploymentMode: 'cloud' });
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.orchestrator.environment).toContain('DEPLOYMENT_MODE=cloud');
    expect(parsed.services.orchestrator.environment).toContain('CLUSTER_VARIANT=cluster-base');
    expect(parsed.services.worker.environment).toContain('DEPLOYMENT_MODE=cloud');
    expect(parsed.services.worker.environment).toContain('CLUSTER_VARIANT=cluster-base');
  });

  it('includes worker deploy.replicas', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.services.worker.deploy.replicas).toBe('${WORKER_COUNT:-1}');
  });

  it('declares all expected named volumes', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    expect(parsed.volumes).toHaveProperty('workspace');
    expect(parsed.volumes).toHaveProperty('shared-packages');
    expect(parsed.volumes).toHaveProperty('npm-cache');
    expect(parsed.volumes).toHaveProperty('generacy-data');
    expect(parsed.volumes).toHaveProperty('redis-data');
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
    expect(content).toContain('REPO_BRANCH=main');
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
    expect(content).toContain('REPO_BRANCH=main');
    expect(content).toContain('GENERACY_CHANNEL=preview');
    expect(content).toContain('WORKER_COUNT=1');
    expect(content).toContain('ORCHESTRATOR_PORT=3100');
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
