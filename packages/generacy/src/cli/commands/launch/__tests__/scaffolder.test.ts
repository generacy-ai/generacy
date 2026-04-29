import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { LaunchConfig } from '../types.js';
import { resolveProjectDir, scaffoldProject } from '../scaffolder.js';

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const mockConfig: LaunchConfig = {
  projectId: 'proj_abc123',
  projectName: 'my-project',
  variant: 'standard',
  cloudUrl: 'https://api.generacy.ai',
  clusterId: 'cluster_abc123',
  imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
  repos: { primary: 'generacy-ai/example-project' },
};

// ---------------------------------------------------------------------------
// resolveProjectDir
// ---------------------------------------------------------------------------

describe('resolveProjectDir', () => {
  it('returns ~/Generacy/<projectName> by default', () => {
    const original = process.env.HOME;
    // Mock os.homedir() indirectly by checking the result shape.
    const result = resolveProjectDir('my-project');
    expect(result).toBe(join(homedir(), 'Generacy', 'my-project'));
    process.env.HOME = original;
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

  // -------------------------------------------------------------------------
  // Directory creation
  // -------------------------------------------------------------------------

  it('creates .generacy/ directory inside projectDir', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    expect(existsSync(join(projectDir, '.generacy'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // cluster.yaml
  // -------------------------------------------------------------------------

  it('writes cluster.yaml with correct YAML content', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const raw = readFileSync(join(projectDir, '.generacy', 'cluster.yaml'), 'utf-8');
    const parsed = parse(raw);

    expect(parsed).toEqual({
      variant: 'standard',
      imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
      cloudUrl: 'https://api.generacy.ai',
      ports: {
        orchestrator: 3100,
        relay: 3101,
        controlPlane: 3102,
      },
    });
  });

  // -------------------------------------------------------------------------
  // cluster.json
  // -------------------------------------------------------------------------

  it('writes cluster.json with correct JSON content', () => {
    const projectDir = join(tempDir, 'new-project');

    const before = new Date().toISOString();
    scaffoldProject(projectDir, mockConfig);
    const after = new Date().toISOString();

    const raw = readFileSync(join(projectDir, '.generacy', 'cluster.json'), 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.clusterId).toBe('cluster_abc123');
    expect(parsed.projectId).toBe('proj_abc123');
    expect(parsed.projectName).toBe('my-project');
    expect(parsed.variant).toBe('standard');
    expect(parsed.cloudUrl).toBe('https://api.generacy.ai');
    expect(parsed.imageTag).toBe('ghcr.io/generacy-ai/cluster-base:1.5.0');

    // createdAt should be a valid ISO timestamp within the test window
    expect(parsed.createdAt).toBeDefined();
    expect(parsed.createdAt >= before).toBe(true);
    expect(parsed.createdAt <= after).toBe(true);
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
    expect(parsed.services.cluster.restart).toBe('unless-stopped');
    expect(parsed.services.cluster.ports).toEqual(['3100:3100', '3101:3101', '3102:3102']);
    expect(parsed.services.cluster.volumes).toEqual([
      'cluster-data:/var/lib/generacy',
      '/var/run/docker.sock:/var/run/docker.sock',
    ]);
    expect(parsed.services.cluster.environment).toEqual([
      'GENERACY_CLOUD_URL=https://api.generacy.ai',
      'GENERACY_CLUSTER_ID=cluster_abc123',
      'GENERACY_PROJECT_ID=proj_abc123',
    ]);
    expect(parsed.volumes).toHaveProperty('cluster-data');
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
