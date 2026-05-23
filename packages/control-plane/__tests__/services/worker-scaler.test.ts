import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/services/project-dir-resolver.js', () => ({
  resolveGeneracyDir: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: vi.fn(),
  };
});

import { readCurrentCount, updateEnvFile, updateClusterYaml, scaleWorkers } from '../../src/services/worker-scaler.js';
import { resolveGeneracyDir } from '../../src/services/project-dir-resolver.js';
import { spawn } from 'node:child_process';

describe('worker-scaler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'worker-scaler-test-'));
    vi.mocked(resolveGeneracyDir).mockResolvedValue(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('readCurrentCount', () => {
    it('reads WORKER_COUNT from .env', async () => {
      const envPath = join(tempDir, '.env');
      writeFileSync(envPath, 'FOO=bar\nWORKER_COUNT=3\nBAZ=qux\n');

      const count = await readCurrentCount(envPath);
      expect(count).toBe(3);
    });

    it('returns 1 when WORKER_COUNT line is missing', async () => {
      const envPath = join(tempDir, '.env');
      writeFileSync(envPath, 'FOO=bar\n');

      const count = await readCurrentCount(envPath);
      expect(count).toBe(1);
    });

    it('returns 1 when .env file does not exist', async () => {
      const envPath = join(tempDir, '.env');
      const count = await readCurrentCount(envPath);
      expect(count).toBe(1);
    });
  });

  describe('updateEnvFile', () => {
    it('replaces existing WORKER_COUNT line', async () => {
      const envPath = join(tempDir, '.env');
      writeFileSync(envPath, 'FOO=bar\nWORKER_COUNT=1\nBAZ=qux\n');

      await updateEnvFile(envPath, 5);

      const content = readFileSync(envPath, 'utf-8');
      expect(content).toContain('WORKER_COUNT=5');
      expect(content).not.toContain('WORKER_COUNT=1');
      expect(content).toContain('FOO=bar');
      expect(content).toContain('BAZ=qux');
    });

    it('appends WORKER_COUNT when missing', async () => {
      const envPath = join(tempDir, '.env');
      writeFileSync(envPath, 'FOO=bar\n');

      await updateEnvFile(envPath, 3);

      const content = readFileSync(envPath, 'utf-8');
      expect(content).toContain('FOO=bar');
      expect(content).toContain('WORKER_COUNT=3');
    });

    it('creates .env file when it does not exist', async () => {
      const envPath = join(tempDir, '.env');

      await updateEnvFile(envPath, 2);

      const content = readFileSync(envPath, 'utf-8');
      expect(content).toBe('WORKER_COUNT=2\n');
    });

    // EXDEV prevention: temp file must be created in dirname(targetPath), not os.tmpdir(),
    // because rename(2) only works within a single filesystem. In containers, /tmp and
    // /workspaces/ are often on different filesystems (overlay vs named volume).
    it('creates temp file in target directory, not os.tmpdir()', async () => {
      const subDir = join(tempDir, 'nested');
      mkdirSync(subDir);
      const envPath = join(subDir, '.env');

      await updateEnvFile(envPath, 7);

      // After successful atomic write, no .tmp files should remain in the target dir
      const remaining = readdirSync(subDir).filter(f => f.endsWith('.tmp'));
      expect(remaining).toHaveLength(0);

      // The file should exist with correct content (rename succeeded = same filesystem)
      const content = readFileSync(envPath, 'utf-8');
      expect(content).toBe('WORKER_COUNT=7\n');
    });

    it('handles file without trailing newline', async () => {
      const envPath = join(tempDir, '.env');
      writeFileSync(envPath, 'FOO=bar');

      await updateEnvFile(envPath, 4);

      const content = readFileSync(envPath, 'utf-8');
      expect(content).toBe('FOO=bar\nWORKER_COUNT=4\n');
    });
  });

  describe('updateClusterYaml', () => {
    it('updates existing workers field', async () => {
      const yamlPath = join(tempDir, 'cluster.yaml');
      writeFileSync(yamlPath, 'channel: stable\nworkers: 1\nvariant: cluster-base\n');

      await updateClusterYaml(yamlPath, 5);

      const content = readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('workers: 5');
      expect(content).toContain('channel: stable');
      expect(content).toContain('variant: cluster-base');
    });

    it('adds workers field when missing', async () => {
      const yamlPath = join(tempDir, 'cluster.yaml');
      writeFileSync(yamlPath, 'channel: stable\nvariant: cluster-base\n');

      await updateClusterYaml(yamlPath, 3);

      const content = readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('workers: 3');
    });

    it('creates cluster.yaml when it does not exist', async () => {
      const yamlPath = join(tempDir, 'cluster.yaml');

      await updateClusterYaml(yamlPath, 2);

      const content = readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('workers: 2');
    });
  });

  describe('scaleWorkers', () => {
    it('orchestrates env update, yaml update, and docker scale', async () => {
      // Set up files
      const envPath = join(tempDir, '.env');
      const yamlPath = join(tempDir, 'cluster.yaml');
      const composePath = join(tempDir, 'docker-compose.yml');
      writeFileSync(envPath, 'WORKER_COUNT=2\n');
      writeFileSync(yamlPath, 'channel: stable\nworkers: 2\nvariant: cluster-base\n');
      writeFileSync(composePath, 'version: "3"\n');

      // Mock spawn to simulate successful docker compose
      const mockChild = {
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          if (event === 'close') {
            setTimeout(() => cb(0), 0);
          }
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      // Mock fetch for metadata refresh
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const result = await scaleWorkers({
        count: 4,
        orchestratorApiKey: 'test-key',
        orchestratorUrl: 'http://localhost:3100',
      });

      expect(result.previousCount).toBe(2);
      expect(result.requestedCount).toBe(4);

      // Verify .env was updated
      const envContent = readFileSync(envPath, 'utf-8');
      expect(envContent).toContain('WORKER_COUNT=4');

      // Verify cluster.yaml was updated
      const yamlContent = readFileSync(yamlPath, 'utf-8');
      expect(yamlContent).toContain('workers: 4');

      // Verify docker compose was called
      expect(spawn).toHaveBeenCalledWith(
        'docker',
        ['compose', '-f', composePath, 'up', '-d', '--scale', 'worker=4'],
        expect.objectContaining({
          env: expect.objectContaining({ DOCKER_HOST: expect.any(String) }),
        }),
      );
    });

    it('returns previousCount=1 when .env is missing', async () => {
      const composePath = join(tempDir, 'docker-compose.yml');
      writeFileSync(composePath, 'version: "3"\n');

      const mockChild = {
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          if (event === 'close') {
            setTimeout(() => cb(0), 0);
          }
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      const result = await scaleWorkers({ count: 3 });

      expect(result.previousCount).toBe(1);
      expect(result.requestedCount).toBe(3);
    });
  });
});
