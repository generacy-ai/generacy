import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { LaunchConfig } from '../types.js';
import { resolveProjectDir, scaffoldProject } from '../scaffolder.js';
import { ClusterJsonSchema, ClusterYamlSchema } from '../../cluster/context.js';

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const mockConfig: LaunchConfig = {
  projectId: 'proj_abc123',
  projectName: 'my-project',
  variant: 'cluster-base',
  cloudUrl: 'https://api.generacy.ai',
  clusterId: 'cluster_abc123',
  imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
  orgId: 'org_xyz789',
  repos: {
    primary: 'generacy-ai/example-project',
    dev: ['generacy-ai/dev-tools'],
    clone: ['generacy-ai/shared-lib'],
  },
};

// ---------------------------------------------------------------------------
// resolveProjectDir
// ---------------------------------------------------------------------------

describe('resolveProjectDir', () => {
  it('returns ~/Generacy/<projectName> by default', () => {
    const result = resolveProjectDir('my-project');
    expect(result).toBe(join(homedir(), 'Generacy', 'my-project'));
  });

  it('resolves --dir override to an absolute path', () => {
    const result = resolveProjectDir('my-project', '/tmp/custom-dir');
    expect(result).toBe('/tmp/custom-dir');
  });

  it('resolves a relative --dir override relative to cwd', () => {
    const result = resolveProjectDir('my-project', 'relative/path');
    expect(result).toBe(join(process.cwd(), 'relative/path'));
  });
});

// ---------------------------------------------------------------------------
// scaffoldProject
// ---------------------------------------------------------------------------

describe('scaffoldProject', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scaffolder-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .generacy/ directory inside projectDir', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);
    expect(existsSync(join(projectDir, '.generacy'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // cluster.yaml — minimal schema
  // -------------------------------------------------------------------------

  it('writes cluster.yaml with only channel, workers, variant', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const raw = readFileSync(join(projectDir, '.generacy', 'cluster.yaml'), 'utf-8');
    const parsed = parse(raw);

    expect(parsed).toEqual({
      channel: 'stable',
      workers: 1,
      variant: 'cluster-base',
    });
    expect(parsed).not.toHaveProperty('imageTag');
    expect(parsed).not.toHaveProperty('cloudUrl');
    expect(parsed).not.toHaveProperty('ports');
  });

  it('cluster.yaml output validates against ClusterYamlSchema', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const raw = readFileSync(join(projectDir, '.generacy', 'cluster.yaml'), 'utf-8');
    const parsed = parse(raw);

    const result = ClusterYamlSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // cluster.json — snake_case schema
  // -------------------------------------------------------------------------

  it('writes cluster.json with snake_case fields', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const raw = readFileSync(join(projectDir, '.generacy', 'cluster.json'), 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.cluster_id).toBe('cluster_abc123');
    expect(parsed.project_id).toBe('proj_abc123');
    expect(parsed.org_id).toBe('org_xyz789');
    expect(parsed.cloud_url).toBe('https://api.generacy.ai');
  });

  it('cluster.json output validates against ClusterJsonSchema', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const raw = readFileSync(join(projectDir, '.generacy', 'cluster.json'), 'utf-8');
    const parsed = JSON.parse(raw);

    const result = ClusterJsonSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('cluster.json does not contain camelCase or extra fields', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const raw = readFileSync(join(projectDir, '.generacy', 'cluster.json'), 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed).not.toHaveProperty('clusterId');
    expect(parsed).not.toHaveProperty('projectId');
    expect(parsed).not.toHaveProperty('orgId');
    expect(parsed).not.toHaveProperty('cloudUrl');
    expect(parsed).not.toHaveProperty('projectName');
    expect(parsed).not.toHaveProperty('imageTag');
    expect(parsed).not.toHaveProperty('createdAt');
  });

  // -------------------------------------------------------------------------
  // docker-compose.yml
  // -------------------------------------------------------------------------

  it('writes docker-compose.yml with correct content', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const raw = readFileSync(join(projectDir, '.generacy', 'docker-compose.yml'), 'utf-8');
    const parsed = parse(raw);

    expect(parsed.version).toBe('3.8');
    expect(parsed.services.cluster.image).toBe('ghcr.io/generacy-ai/cluster-base:1.5.0');
    expect(parsed.services.cluster.container_name).toBe('generacy-cluster-cluster_abc123');
    expect(parsed.services.cluster.environment).toContain('GENERACY_CLOUD_URL=https://api.generacy.ai');
    expect(parsed.services.cluster.environment).toContain('GENERACY_CLUSTER_ID=cluster_abc123');
    expect(parsed.services.cluster.environment).toContain('GENERACY_PROJECT_ID=proj_abc123');
    expect(parsed.services.cluster.environment).toContain('DEPLOYMENT_MODE=local');
    expect(parsed.services.cluster.environment).toContain('CLUSTER_VARIANT=cluster-base');
  });

  // -------------------------------------------------------------------------
  // Error: .generacy/ already exists
  // -------------------------------------------------------------------------

  it('throws error if .generacy/ already exists', () => {
    const projectDir = join(tempDir, 'existing-project');
    mkdirSync(join(projectDir, '.generacy'), { recursive: true });

    expect(() => scaffoldProject(projectDir, mockConfig)).toThrow(
      /already contains a \.generacy\/ folder/,
    );
  });
});
