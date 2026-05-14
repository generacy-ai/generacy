import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { clearStaleActivation } from '../volume-cleanup.js';

const mockedExecSync = vi.mocked(execSync);

describe('clearStaleActivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true on success', () => {
    mockedExecSync.mockReturnValue(Buffer.from(''));

    expect(clearStaleActivation('my-project')).toBe(true);
  });

  it('runs docker command with correct volume name', () => {
    mockedExecSync.mockReturnValue(Buffer.from(''));

    clearStaleActivation('my-project');

    const cmd = mockedExecSync.mock.calls[0]![0] as string;
    expect(cmd).toContain('my-project_generacy-data');
  });

  it('targets cluster-api-key, cluster.json, and wizard-credentials.env', () => {
    mockedExecSync.mockReturnValue(Buffer.from(''));

    clearStaleActivation('my-project');

    const cmd = mockedExecSync.mock.calls[0]![0] as string;
    expect(cmd).toContain('/v/cluster-api-key');
    expect(cmd).toContain('/v/cluster.json');
    expect(cmd).toContain('/v/wizard-credentials.env');
  });

  it('uses docker run --rm with alpine', () => {
    mockedExecSync.mockReturnValue(Buffer.from(''));

    clearStaleActivation('my-project');

    const cmd = mockedExecSync.mock.calls[0]![0] as string;
    expect(cmd).toMatch(/^docker run --rm/);
    expect(cmd).toContain('alpine');
  });

  it('returns false on failure without throwing', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('docker not available');
    });

    expect(clearStaleActivation('my-project')).toBe(false);
  });
});
