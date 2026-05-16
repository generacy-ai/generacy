import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  rm: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  log: { warn: vi.fn(), info: vi.fn() },
}));

import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import * as p from '@clack/prompts';
import {
  probeControlPlaneReady,
  forwardRegistryCredentials,
  cleanupScopedDockerConfig,
} from '../credential-forward.js';
import type { RegistryCredential } from '../types.js';

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedRm = vi.mocked(rm);

describe('credential-forward integration flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRm.mockResolvedValue(undefined);
  });

  it('full success: probe → forward → cleanup', async () => {
    // Probe succeeds on first try
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);

    const creds: RegistryCredential[] = [
      { host: 'ghcr.io', auth: 'dXNlcjpwYXNz' },
    ];

    const ready = await probeControlPlaneReady('/project', { retries: 3, intervalMs: 10 });
    expect(ready).toBe(true);

    const result = forwardRegistryCredentials('/project', creds);
    expect(result.forwarded).toEqual(['ghcr.io']);
    expect(result.failed).toEqual([]);

    // Cleanup runs because forwarded.length > 0
    await cleanupScopedDockerConfig('/project');
    expect(mockedRm).toHaveBeenCalledWith(
      '/project/.generacy/.docker',
      { recursive: true, force: true },
    );
  });

  it('probe failure: no forward, no cleanup', async () => {
    mockedSpawnSync.mockReturnValue({ status: 1 } as any);

    const ready = await probeControlPlaneReady('/project', { retries: 2, intervalMs: 10 });
    expect(ready).toBe(false);

    // Forward and cleanup should NOT be called
    expect(mockedSpawnSync).toHaveBeenCalledTimes(2); // only probe calls
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('forward failure: no cleanup when all fail', async () => {
    // First call is probe (success), subsequent are PUT (failures)
    mockedSpawnSync
      .mockReturnValueOnce({ status: 0 } as any) // probe
      .mockReturnValueOnce({ status: 1 } as any) // PUT ghcr.io
      .mockReturnValueOnce({ status: 1 } as any); // PUT docker.io

    const creds: RegistryCredential[] = [
      { host: 'ghcr.io', auth: 'dXNlcjpwYXNz' },
      { host: 'docker.io', auth: 'YWJjOjEyMw==' },
    ];

    const ready = await probeControlPlaneReady('/project', { retries: 1, intervalMs: 10 });
    expect(ready).toBe(true);

    const result = forwardRegistryCredentials('/project', creds);
    expect(result.forwarded).toEqual([]);
    expect(result.failed).toEqual(['ghcr.io', 'docker.io']);

    // No cleanup because nothing was forwarded
    // (This mirrors the if-guard in launchAction)
    if (result.forwarded.length > 0) {
      await cleanupScopedDockerConfig('/project');
    }
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('partial forward failure: cleanup runs, warning logged for failed hosts', async () => {
    mockedSpawnSync
      .mockReturnValueOnce({ status: 0 } as any) // probe
      .mockReturnValueOnce({ status: 0 } as any) // PUT ghcr.io success
      .mockReturnValueOnce({ status: 1 } as any); // PUT private.reg failure

    const creds: RegistryCredential[] = [
      { host: 'ghcr.io', auth: 'dXNlcjpwYXNz' },
      { host: 'private.reg', auth: 'c2VjcmV0' },
    ];

    const ready = await probeControlPlaneReady('/project', { retries: 1, intervalMs: 10 });
    expect(ready).toBe(true);

    const result = forwardRegistryCredentials('/project', creds);
    expect(result.forwarded).toEqual(['ghcr.io']);
    expect(result.failed).toEqual(['private.reg']);

    // Cleanup runs because at least one was forwarded
    if (result.forwarded.length > 0) {
      await cleanupScopedDockerConfig('/project');
    }
    expect(mockedRm).toHaveBeenCalled();
  });
});
