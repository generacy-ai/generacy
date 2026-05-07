import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import {
  scaffoldClusterJson,
  scaffoldClusterYaml,
  scaffoldDockerCompose,
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scaffolder-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes docker-compose.yml with image, ports, env, volumes', () => {
    scaffoldDockerCompose(dir, {
      imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
      clusterId: 'clust_abc',
      projectId: 'proj_def',
      projectName: 'todo-list-example',
      cloudUrl: 'https://api.generacy.ai',
      variant: 'cluster-base',
    });

    const raw = readFileSync(join(dir, 'docker-compose.yml'), 'utf-8');
    const parsed = parse(raw);

    expect(parsed.name).toBe('todo-list-example');
    expect(parsed.services.cluster.image).toBe('ghcr.io/generacy-ai/cluster-base:1.5.0');
    expect(parsed.services.cluster.environment).toContain('GENERACY_CLUSTER_ID=clust_abc');
    expect(parsed.services.cluster.environment).toContain('GENERACY_PROJECT_ID=proj_def');
    expect(parsed.services.cluster.environment).toContain('GENERACY_CLOUD_URL=https://api.generacy.ai');
    expect(parsed.services.cluster.environment).toContain('DEPLOYMENT_MODE=local');
    expect(parsed.services.cluster.environment).toContain('CLUSTER_VARIANT=cluster-base');
  });

  it('sanitizes uppercase, spaces, and other illegal characters in projectName', () => {
    scaffoldDockerCompose(dir, {
      imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
      clusterId: 'clust_abc',
      projectId: 'proj_def',
      projectName: 'My Awesome Project!',
      cloudUrl: 'https://api.generacy.ai',
      variant: 'cluster-base',
    });

    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));
    expect(parsed.name).toBe('my-awesome-project');
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
