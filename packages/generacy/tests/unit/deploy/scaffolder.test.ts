import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { scaffoldBundle } from '../../../src/cli/commands/deploy/scaffolder.js';
import type { LaunchConfig } from '../../../src/cli/commands/deploy/cloud-client.js';
import type { ActivationResult } from '@generacy-ai/activation-client';

const testConfig: LaunchConfig = {
  projectId: 'proj-123',
  projectName: 'My Test Project',
  variant: 'cluster-base',
  cloudUrl: 'https://cloud.generacy.ai',
  clusterId: 'cluster-abc',
  imageTag: 'generacy/cluster:v1.2.3',
  orgId: 'org-deploy',
  repos: { primary: 'https://github.com/org/repo.git' },
};

const testActivation: ActivationResult = {
  apiKey: 'ak_secret_key',
  clusterApiKeyId: 'key-id-456',
  clusterId: 'cluster-abc',
  projectId: 'proj-123',
  orgId: 'org-789',
};

const testCloudUrl = 'https://api.generacy.ai';

describe('scaffoldBundle', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  function callScaffold() {
    const dir = scaffoldBundle(testConfig, testActivation, testCloudUrl);
    tmpDirs.push(dir);
    return dir;
  }

  it('returns a temp directory path that exists', () => {
    const dir = callScaffold();
    expect(typeof dir).toBe('string');
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain('generacy-deploy-');
  });

  describe('.generacy/cluster.yaml', () => {
    it('exists and contains channel, workers, variant', () => {
      const dir = callScaffold();
      const filePath = join(dir, '.generacy', 'cluster.yaml');
      expect(existsSync(filePath)).toBe(true);

      const content = parse(readFileSync(filePath, 'utf-8'));
      expect(content.channel).toBe('stable');
      expect(content.workers).toBe(1);
      expect(content.variant).toBe('cluster-base');
    });
  });

  describe('.generacy/cluster.json', () => {
    it('exists and contains snake_case fields', () => {
      const dir = callScaffold();
      const filePath = join(dir, '.generacy', 'cluster.json');
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(content.cluster_id).toBe('cluster-abc');
      expect(content.project_id).toBe('proj-123');
      expect(content.org_id).toBe('org-789');
      expect(content.cloud_url).toBe(testCloudUrl);
    });
  });

  describe('docker-compose.yml', () => {
    it('exists in .generacy/ directory', () => {
      const dir = callScaffold();
      const filePath = join(dir, '.generacy', 'docker-compose.yml');
      expect(existsSync(filePath)).toBe(true);
    });

    it('contains multi-service structure (orchestrator, worker, redis)', () => {
      const dir = callScaffold();
      const content = parse(readFileSync(join(dir, '.generacy', 'docker-compose.yml'), 'utf-8'));

      expect(content.services).toHaveProperty('orchestrator');
      expect(content.services).toHaveProperty('worker');
      expect(content.services).toHaveProperty('redis');
      expect(content.services).not.toHaveProperty('cluster');
    });

    it('uses correct image for orchestrator and worker', () => {
      const dir = callScaffold();
      const content = parse(readFileSync(join(dir, '.generacy', 'docker-compose.yml'), 'utf-8'));

      expect(content.services.orchestrator.image).toBe('generacy/cluster:v1.2.3');
      expect(content.services.worker.image).toBe('generacy/cluster:v1.2.3');
    });

    it('uses cloud deployment mode with fixed port binding', () => {
      const dir = callScaffold();
      const content = parse(readFileSync(join(dir, '.generacy', 'docker-compose.yml'), 'utf-8'));

      expect(content.services.orchestrator.ports).toEqual(['${ORCHESTRATOR_PORT:-3100}:3100']);
      expect(content.services.orchestrator.environment).toContain('DEPLOYMENT_MODE=cloud');
    });

    it('uses named volume for claude-config (not bind mount)', () => {
      const dir = callScaffold();
      const content = parse(readFileSync(join(dir, '.generacy', 'docker-compose.yml'), 'utf-8'));

      const orchVolumes = content.services.orchestrator.volumes as string[];
      expect(orchVolumes).toContain('claude-config:/home/node/.claude.json');
      expect(content.volumes).toHaveProperty('claude-config');
    });

    it('mounts docker socket at /var/run/docker-host.sock', () => {
      const dir = callScaffold();
      const content = parse(readFileSync(join(dir, '.generacy', 'docker-compose.yml'), 'utf-8'));

      const orchVolumes = content.services.orchestrator.volumes as string[];
      expect(orchVolumes).toContain('/var/run/docker.sock:/var/run/docker-host.sock');
    });
  });

  describe('.generacy/.env', () => {
    it('exists and contains identity vars', () => {
      const dir = callScaffold();
      const envPath = join(dir, '.generacy', '.env');
      expect(existsSync(envPath)).toBe(true);

      const content = readFileSync(envPath, 'utf-8');
      expect(content).toContain('GENERACY_CLUSTER_ID=cluster-abc');
      expect(content).toContain('GENERACY_PROJECT_ID=proj-123');
      expect(content).toContain('GENERACY_ORG_ID=org-789');
      expect(content).toContain('GENERACY_API_URL=https://api.generacy.ai');
      expect(content).toContain('GENERACY_RELAY_URL=wss://api.generacy.ai/relay?projectId=proj-123');
      expect(content).not.toContain('GENERACY_CLOUD_URL');
    });
  });
});
