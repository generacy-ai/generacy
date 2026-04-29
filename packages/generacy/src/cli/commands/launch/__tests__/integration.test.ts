import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Mock child_process for Docker operations
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  exec: vi.fn(),
}));

// Mock @clack/prompts
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() },
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(() => true),
}));

// Mock logger
vi.mock('../../../../utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock exec utility
vi.mock('../../../../utils/exec.js', () => ({
  execSafe: vi.fn(() => ({ ok: true, stdout: 'Server Version: 27.0.3', stderr: '' })),
}));

// Mock os.homedir for registry
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: vi.fn() };
});

import { execSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { fetchLaunchConfig } from '../cloud-client.js';

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedHomedir = vi.mocked(homedir);

// ---------------------------------------------------------------------------
// Fixture HTTP server
// ---------------------------------------------------------------------------

const VALID_CONFIG: LaunchConfig = {
  projectId: 'proj_test001',
  projectName: 'test-project',
  variant: 'standard',
  cloudUrl: 'http://localhost:3000',
  clusterId: 'cluster_test001',
  imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
  repos: { primary: 'generacy-ai/example-project' },
};

let server: Server;
let serverUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(VALID_CONFIG));
  };
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function createMockChildProcess() {
  const cp = new EventEmitter() as any;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.killed = false;
  cp.kill = vi.fn(() => { cp.killed = true; });
  return cp;
}

beforeEach(() => {
  vi.clearAllMocks();
  tempDir = mkdtempSync(join(tmpdir(), 'launch-integration-'));
  mockedHomedir.mockReturnValue(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('launch integration', () => {
  describe('cloud client → scaffolder flow', () => {
    it('fetches config from fixture server and validates with Zod', async () => {
      const config = await fetchLaunchConfig(serverUrl, 'test-claim');

      expect(config.projectId).toBe('proj_test001');
      expect(config.projectName).toBe('test-project');
      expect(config.clusterId).toBe('cluster_test001');
      expect(config.imageTag).toBe('ghcr.io/generacy-ai/cluster-base:1.5.0');
    });

    it('scaffolds project directory with correct files from fetched config', async () => {
      const { scaffoldProject } = await import('../scaffolder.js');
      const config = await fetchLaunchConfig(serverUrl, 'test-claim');

      const projectDir = join(tempDir, 'test-project');
      scaffoldProject(projectDir, config);

      // Verify all three files exist
      const generacyDir = join(projectDir, '.generacy');
      expect(existsSync(join(generacyDir, 'cluster.yaml'))).toBe(true);
      expect(existsSync(join(generacyDir, 'cluster.json'))).toBe(true);
      expect(existsSync(join(generacyDir, 'docker-compose.yml'))).toBe(true);

      // Verify cluster.json content
      const metadata = JSON.parse(readFileSync(join(generacyDir, 'cluster.json'), 'utf-8'));
      expect(metadata.clusterId).toBe('cluster_test001');
      expect(metadata.projectId).toBe('proj_test001');
    });
  });

  describe('error paths', () => {
    it('cloud unreachable — fetchLaunchConfig throws', async () => {
      await expect(
        fetchLaunchConfig('http://127.0.0.1:1', 'test-claim'),
      ).rejects.toThrow('Could not reach Generacy cloud');
    });

    it('invalid claim code — server returns 404', async () => {
      handler = (_req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      };

      await expect(
        fetchLaunchConfig(serverUrl, 'invalid-claim'),
      ).rejects.toThrow('Claim code is invalid or expired');

      // Restore handler
      handler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(VALID_CONFIG));
      };
    });

    it('Docker compose pull failure', async () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('pull failed: image not found');
      });

      const { pullImage } = await import('../compose.js');
      expect(() => pullImage('/fake/dir')).toThrow('docker compose pull failed');
    });

    it('Docker compose up failure', async () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('up failed: port already in use');
      });

      const { startCluster } = await import('../compose.js');
      expect(() => startCluster('/fake/dir')).toThrow('docker compose up failed');
    });

    it('activation timeout', async () => {
      const mockChild = createMockChildProcess();
      mockedSpawn.mockReturnValue(mockChild as any);

      const { streamLogsUntilActivation } = await import('../compose.js');
      const promise = streamLogsUntilActivation('/fake/dir', 100);

      // Emit non-matching data
      mockChild.stdout.emit('data', Buffer.from('Starting cluster...\n'));

      await expect(promise).rejects.toThrow(/timed out/i);
    });
  });

  describe('registry flow', () => {
    it('registers cluster after successful scaffold', async () => {
      // Dynamic import to pick up mocked homedir
      vi.resetModules();
      mockedHomedir.mockReturnValue(tempDir);

      const { registerCluster } = await import('../registry.js');

      registerCluster({
        clusterId: 'cluster_test001',
        name: 'test-project',
        path: join(tempDir, 'test-project'),
        composePath: join(tempDir, 'test-project', '.generacy', 'docker-compose.yml'),
        variant: 'standard',
        channel: 'stable',
        cloudUrl: 'http://localhost:3000',
        lastSeen: '2026-04-29T12:00:00.000Z',
        createdAt: '2026-04-29T12:00:00.000Z',
      });

      const registryPath = join(tempDir, '.generacy', 'clusters.json');
      expect(existsSync(registryPath)).toBe(true);

      const entries = JSON.parse(readFileSync(registryPath, 'utf-8'));
      expect(entries).toHaveLength(1);
      expect(entries[0].clusterId).toBe('cluster_test001');
    });
  });
});
