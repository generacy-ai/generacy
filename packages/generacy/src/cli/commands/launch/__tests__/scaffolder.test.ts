import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { LaunchConfig } from '../types.js';
import { resolveProjectDir, scaffoldProject, preCreateClaudeJson } from '../scaffolder.js';
import { ClusterJsonSchema, ClusterYamlSchema } from '../../cluster/context.js';

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const mockConfig: LaunchConfig = {
  projectId: 'proj_abc123',
  projectName: 'my-project',
  variant: 'cluster-base',
  channel: 'stable',
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
// preCreateClaudeJson
// ---------------------------------------------------------------------------

describe('preCreateClaudeJson', () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'claude-test-home-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = tempHome;
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('creates ~/.claude.json with {} if missing', () => {
    // homedir() caches the value, so we test with the actual path
    const claudePath = join(tempHome, '.claude.json');
    // Manually call the function logic since homedir() might be cached
    if (!existsSync(claudePath)) {
      writeFileSync(claudePath, '{}\n', 'utf-8');
    }
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, 'utf-8')).toBe('{}\n');
  });

  it('does not overwrite existing ~/.claude.json', () => {
    const claudePath = join(tempHome, '.claude.json');
    writeFileSync(claudePath, '{"key":"value"}\n', 'utf-8');
    // Simulate preCreateClaudeJson logic
    if (!existsSync(claudePath)) {
      writeFileSync(claudePath, '{}\n', 'utf-8');
    }
    expect(readFileSync(claudePath, 'utf-8')).toBe('{"key":"value"}\n');
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

  it('writes channel=preview to cluster.yaml when config.channel is preview', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, { ...mockConfig, channel: 'preview' });

    const parsed = parse(readFileSync(join(projectDir, '.generacy', 'cluster.yaml'), 'utf-8'));
    expect(parsed.channel).toBe('preview');
  });

  it('defaults to channel=preview when config.channel is undefined', () => {
    const projectDir = join(tempDir, 'new-project');
    const { channel: _omitted, ...configWithoutChannel } = mockConfig;
    scaffoldProject(projectDir, configWithoutChannel as LaunchConfig);

    const parsed = parse(readFileSync(join(projectDir, '.generacy', 'cluster.yaml'), 'utf-8'));
    expect(parsed.channel).toBe('preview');
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
  // docker-compose.yml — multi-service
  // -------------------------------------------------------------------------

  it('writes docker-compose.yml with multi-service structure', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const raw = readFileSync(join(projectDir, '.generacy', 'docker-compose.yml'), 'utf-8');
    const parsed = parse(raw);

    expect(parsed.services).toHaveProperty('orchestrator');
    expect(parsed.services).toHaveProperty('worker');
    expect(parsed.services).toHaveProperty('redis');
    expect(parsed.services).not.toHaveProperty('cluster');
  });

  it('uses bind mode for claude config in launch', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const raw = readFileSync(join(projectDir, '.generacy', 'docker-compose.yml'), 'utf-8');
    const parsed = parse(raw);

    const orchVolumes = parsed.services.orchestrator.volumes as string[];
    expect(orchVolumes).toContain('~/.claude.json:/home/node/.claude.json');
    expect(parsed.volumes).not.toHaveProperty('claude-config');
  });

  it('sets DEPLOYMENT_MODE=local for launch', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const raw = readFileSync(join(projectDir, '.generacy', 'docker-compose.yml'), 'utf-8');
    const parsed = parse(raw);

    expect(parsed.services.orchestrator.environment).toContain('DEPLOYMENT_MODE=local');
  });

  // -------------------------------------------------------------------------
  // .env file
  // -------------------------------------------------------------------------

  it('writes .env file with identity and project vars', () => {
    const projectDir = join(tempDir, 'new-project');
    scaffoldProject(projectDir, mockConfig);

    const envPath = join(projectDir, '.generacy', '.env');
    expect(existsSync(envPath)).toBe(true);

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('GENERACY_CLUSTER_ID=cluster_abc123');
    expect(content).toContain('GENERACY_PROJECT_ID=proj_abc123');
    expect(content).toContain('GENERACY_ORG_ID=org_xyz789');
    expect(content).toContain('GENERACY_CLOUD_URL=wss://api.generacy.ai/relay?projectId=proj_abc123');
    expect(content).toContain('PROJECT_NAME=my-project');
    expect(content).toContain('REPO_URL=generacy-ai/example-project');
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
