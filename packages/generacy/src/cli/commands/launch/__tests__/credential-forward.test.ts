import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  rm: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import {
  probeControlPlaneReady,
  forwardRegistryCredentials,
  cleanupScopedDockerConfig,
} from '../credential-forward.js';

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedRm = vi.mocked(rm);

describe('probeControlPlaneReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true on first successful attempt', async () => {
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);

    const result = await probeControlPlaneReady('/project', { retries: 3, intervalMs: 10 });

    expect(result).toBe(true);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('returns true after retries', async () => {
    mockedSpawnSync
      .mockReturnValueOnce({ status: 1 } as any)
      .mockReturnValueOnce({ status: 1 } as any)
      .mockReturnValueOnce({ status: 0 } as any);

    const result = await probeControlPlaneReady('/project', { retries: 5, intervalMs: 10 });

    expect(result).toBe(true);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(3);
  });

  it('returns false when all retries exhausted', async () => {
    mockedSpawnSync.mockReturnValue({ status: 1 } as any);

    const result = await probeControlPlaneReady('/project', { retries: 3, intervalMs: 10 });

    expect(result).toBe(false);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(3);
  });

  it('uses correct docker compose exec command', async () => {
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);

    await probeControlPlaneReady('/my/project', { retries: 1, intervalMs: 10 });

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'compose', '-f', '.generacy/docker-compose.yml', 'exec', '-T', 'orchestrator',
        'curl', '--unix-socket', '/run/generacy-control-plane/control.sock', '-sf',
        'http://localhost/state',
      ]),
      expect.objectContaining({ cwd: '/my/project', stdio: 'pipe' }),
    );
  });
});

describe('forwardRegistryCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all hosts in forwarded on success', () => {
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);

    const result = forwardRegistryCredentials('/project', [
      { host: 'ghcr.io', username: 'user', password: 'pass' },
      { host: 'docker.io', username: 'abc', password: '123' },
    ]);

    expect(result.forwarded).toEqual(['ghcr.io', 'docker.io']);
    expect(result.failed).toEqual([]);
  });

  it('handles partial failure', () => {
    mockedSpawnSync
      .mockReturnValueOnce({ status: 0 } as any)
      .mockReturnValueOnce({ status: 1 } as any);

    const result = forwardRegistryCredentials('/project', [
      { host: 'ghcr.io', username: 'user', password: 'pass' },
      { host: 'private.registry.com', username: 'abc', password: '123' },
    ]);

    expect(result.forwarded).toEqual(['ghcr.io']);
    expect(result.failed).toEqual(['private.registry.com']);
  });

  it('returns all hosts in failed when all fail', () => {
    mockedSpawnSync.mockReturnValue({ status: 1 } as any);

    const result = forwardRegistryCredentials('/project', [
      { host: 'ghcr.io', username: 'user', password: 'pass' },
      { host: 'docker.io', username: 'abc', password: '123' },
    ]);

    expect(result.forwarded).toEqual([]);
    expect(result.failed).toEqual(['ghcr.io', 'docker.io']);
  });

  it('sends correct PUT request with base64-encoded auth in body', () => {
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);

    forwardRegistryCredentials('/project', [
      { host: 'ghcr.io', username: 'user', password: 'pass' },
    ]);

    const expectedAuth = Buffer.from('user:pass').toString('base64');
    const args = mockedSpawnSync.mock.calls[0]![1] as string[];
    expect(args).toContain('-X');
    expect(args).toContain('PUT');
    expect(args).toContain('http://localhost/credentials/registry-ghcr.io');
    expect(args).toContain('Content-Type: application/json');
    expect(args).toContain('x-generacy-actor-user-id: system:cli-launch');
    expect(args).toContain(JSON.stringify({ type: 'registry', value: expectedAuth }));
  });
});

describe('cleanupScopedDockerConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes the .generacy/.docker directory', async () => {
    mockedRm.mockResolvedValue(undefined);

    await cleanupScopedDockerConfig('/project');

    expect(mockedRm).toHaveBeenCalledWith(
      '/project/.generacy/.docker',
      { recursive: true, force: true },
    );
  });

  it('succeeds even when directory does not exist (force: true)', async () => {
    mockedRm.mockResolvedValue(undefined);

    await expect(cleanupScopedDockerConfig('/nonexistent')).resolves.toBeUndefined();
  });
});
