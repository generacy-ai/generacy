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
  variant: 'standard',
  cloudUrl: 'https://cloud.generacy.ai',
  clusterId: 'cluster-abc',
  imageTag: 'generacy/cluster:v1.2.3',
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
    it('exists and contains correct fields', () => {
      const dir = callScaffold();
      const filePath = join(dir, '.generacy', 'cluster.yaml');
      expect(existsSync(filePath)).toBe(true);

      const content = parse(readFileSync(filePath, 'utf-8'));
      expect(content.variant).toBe('standard');
      expect(content.imageTag).toBe('generacy/cluster:v1.2.3');
      expect(content.cloudUrl).toBe(testCloudUrl);
      expect(content.ports).toEqual({
        orchestrator: 3100,
        relay: 3101,
        controlPlane: 3102,
      });
    });
  });

  describe('.generacy/cluster.json', () => {
    it('exists and contains correct fields', () => {
      const dir = callScaffold();
      const filePath = join(dir, '.generacy', 'cluster.json');
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(content.clusterId).toBe('cluster-abc');
      expect(content.projectId).toBe('proj-123');
      expect(content.projectName).toBe('My Test Project');
      expect(content.variant).toBe('standard');
      expect(content.cloudUrl).toBe(testCloudUrl);
      expect(content.imageTag).toBe('generacy/cluster:v1.2.3');
    });

    it('contains a valid ISO 8601 createdAt timestamp', () => {
      const before = new Date().toISOString();
      const dir = callScaffold();
      const after = new Date().toISOString();

      const content = JSON.parse(
        readFileSync(join(dir, '.generacy', 'cluster.json'), 'utf-8'),
      );
      expect(content.createdAt).toBeDefined();
      // Verify it parses as a valid date and falls within the test window
      const ts = new Date(content.createdAt);
      expect(ts.getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      expect(ts.getTime()).toBeLessThanOrEqual(new Date(after).getTime());
    });
  });

  describe('docker-compose.yml', () => {
    it('exists at the root of the temp directory', () => {
      const dir = callScaffold();
      const filePath = join(dir, 'docker-compose.yml');
      expect(existsSync(filePath)).toBe(true);
    });

    it('contains correct service image and container_name', () => {
      const dir = callScaffold();
      const content = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

      expect(content.version).toBe('3.8');
      expect(content.services.cluster.image).toBe('generacy/cluster:v1.2.3');
      expect(content.services.cluster.container_name).toBe('generacy-cluster-cluster-abc');
      expect(content.services.cluster.restart).toBe('unless-stopped');
    });

    it('contains correct port mappings', () => {
      const dir = callScaffold();
      const content = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

      expect(content.services.cluster.ports).toEqual([
        '3100:3100',
        '3101:3101',
        '3102:3102',
      ]);
    });

    it('contains correct volumes', () => {
      const dir = callScaffold();
      const content = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

      expect(content.services.cluster.volumes).toEqual([
        'cluster-data:/var/lib/generacy',
        '/var/run/docker.sock:/var/run/docker.sock',
      ]);
      expect(content.volumes).toHaveProperty('cluster-data');
    });

    it('contains correct environment variables', () => {
      const dir = callScaffold();
      const content = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

      expect(content.services.cluster.environment).toEqual([
        `GENERACY_CLOUD_URL=${testCloudUrl}`,
        'GENERACY_CLUSTER_ID=cluster-abc',
        'GENERACY_PROJECT_ID=proj-123',
        'DEPLOYMENT_MODE=cloud',
        'CLUSTER_VARIANT=standard',
      ]);
    });
  });
});
