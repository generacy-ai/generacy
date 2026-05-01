import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Mock logger — suppress output during tests
// ---------------------------------------------------------------------------

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { getClusterContext } from '../context.js';

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const CLUSTER_YAML = `channel: stable\nworkers: 1\nvariant: cluster-base\n`;

const CLUSTER_JSON = JSON.stringify({
  cluster_id: 'clst_123',
  project_id: 'proj_456',
  org_id: 'org_789',
  cloud_url: 'https://api.generacy.ai',
  activated_at: '2026-01-01T00:00:00.000Z',
});

const DOCKER_COMPOSE_YML = `version: "3"\nservices:\n  app:\n    image: alpine\n    command: sleep infinity\n`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getClusterContext', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-context-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Helper to create .generacy/ fixtures
  // -------------------------------------------------------------------------

  function createGeneracyDir(
    baseDir: string,
    opts: {
      clusterYaml?: string | false;
      clusterJson?: string | false;
      dockerCompose?: string | false;
    } = {},
  ) {
    const generacyDir = path.join(baseDir, '.generacy');
    fs.mkdirSync(generacyDir, { recursive: true });

    if (opts.clusterYaml !== false) {
      fs.writeFileSync(
        path.join(generacyDir, 'cluster.yaml'),
        opts.clusterYaml ?? CLUSTER_YAML,
      );
    }

    if (opts.clusterJson !== false) {
      fs.writeFileSync(
        path.join(generacyDir, 'cluster.json'),
        opts.clusterJson ?? CLUSTER_JSON,
      );
    }

    if (opts.dockerCompose !== false) {
      fs.writeFileSync(
        path.join(generacyDir, 'docker-compose.yml'),
        opts.dockerCompose ?? DOCKER_COMPOSE_YML,
      );
    }

    return generacyDir;
  }

  // -------------------------------------------------------------------------
  // 1. Finds .generacy/ in current directory
  // -------------------------------------------------------------------------

  it('finds .generacy/ in current directory', () => {
    createGeneracyDir(tempDir);

    const ctx = getClusterContext(tempDir);

    expect(ctx.projectRoot).toBe(tempDir);
    expect(ctx.generacyDir).toBe(path.join(tempDir, '.generacy'));
    expect(ctx.composePath).toBe(path.join(tempDir, '.generacy', 'docker-compose.yml'));
    expect(ctx.clusterConfig).toEqual({
      channel: 'stable',
      workers: 1,
      variant: 'cluster-base',
    });
    expect(ctx.clusterIdentity).not.toBeNull();
    expect(ctx.projectName).toBe('clst_123');
  });

  // -------------------------------------------------------------------------
  // 2. Walks upward to find .generacy/
  // -------------------------------------------------------------------------

  it('walks upward to find .generacy/', () => {
    createGeneracyDir(tempDir);

    // Create a nested child directory to use as cwd
    const childDir = path.join(tempDir, 'sub', 'deep');
    fs.mkdirSync(childDir, { recursive: true });

    const ctx = getClusterContext(childDir);

    expect(ctx.projectRoot).toBe(tempDir);
    expect(ctx.generacyDir).toBe(path.join(tempDir, '.generacy'));
  });

  // -------------------------------------------------------------------------
  // 3. Throws when no .generacy/ found
  // -------------------------------------------------------------------------

  it('throws when no .generacy/ found', () => {
    // tempDir is empty — no .generacy/ anywhere up to the filesystem root
    // To prevent walking all the way up (where a real .generacy could exist),
    // create a nested structure within tempDir that cannot escape
    const isolatedDir = path.join(tempDir, 'isolated');
    fs.mkdirSync(isolatedDir, { recursive: true });

    expect(() => getClusterContext(isolatedDir)).toThrow('No cluster found');
  });

  // -------------------------------------------------------------------------
  // 4. Throws when docker-compose.yml missing
  // -------------------------------------------------------------------------

  it('throws when docker-compose.yml missing', () => {
    createGeneracyDir(tempDir, { dockerCompose: false });

    expect(() => getClusterContext(tempDir)).toThrow('Compose file missing');
  });

  // -------------------------------------------------------------------------
  // 5. Parses cluster.json when present
  // -------------------------------------------------------------------------

  it('parses cluster.json when present', () => {
    createGeneracyDir(tempDir);

    const ctx = getClusterContext(tempDir);

    expect(ctx.clusterIdentity).toEqual({
      cluster_id: 'clst_123',
      project_id: 'proj_456',
      org_id: 'org_789',
      cloud_url: 'https://api.generacy.ai',
      activated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(ctx.projectName).toBe('clst_123');
  });

  // -------------------------------------------------------------------------
  // 6. Falls back to dirname when cluster.json missing
  // -------------------------------------------------------------------------

  it('falls back to dirname when cluster.json missing', () => {
    createGeneracyDir(tempDir, { clusterJson: false });

    const ctx = getClusterContext(tempDir);

    expect(ctx.clusterIdentity).toBeNull();
    expect(ctx.projectName).toBe(path.basename(tempDir));
  });

  // -------------------------------------------------------------------------
  // 7. Applies defaults for minimal cluster.yaml
  // -------------------------------------------------------------------------

  it('applies defaults for minimal cluster.yaml', () => {
    createGeneracyDir(tempDir, { clusterYaml: '{}', clusterJson: false });

    const ctx = getClusterContext(tempDir);

    expect(ctx.clusterConfig).toEqual({
      channel: 'stable',
      workers: 1,
      variant: 'cluster-base',
    });
  });
});
