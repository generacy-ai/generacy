import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/exec.js', () => ({
  execSafe: vi.fn(),
}));

import { execSafe } from '../../../utils/exec.js';
import { clearStaleActivation } from '../volume-cleanup.js';

const mockedExecSafe = vi.mocked(execSafe);

describe('clearStaleActivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true on success', () => {
    mockedExecSafe.mockReturnValue({ ok: true, stdout: '', stderr: '' });

    expect(clearStaleActivation('my-project')).toBe(true);
  });

  it('runs docker command with correct volume name', () => {
    mockedExecSafe.mockReturnValue({ ok: true, stdout: '', stderr: '' });

    clearStaleActivation('my-project');

    const cmd = mockedExecSafe.mock.calls[0]![0];
    expect(cmd).toContain('my-project_generacy-data');
  });

  it('targets cluster-api-key, cluster.json, and wizard-credentials.env', () => {
    mockedExecSafe.mockReturnValue({ ok: true, stdout: '', stderr: '' });

    clearStaleActivation('my-project');

    const cmd = mockedExecSafe.mock.calls[0]![0];
    expect(cmd).toContain('/v/cluster-api-key');
    expect(cmd).toContain('/v/cluster.json');
    expect(cmd).toContain('/v/wizard-credentials.env');
  });

  it('uses docker run --rm with alpine', () => {
    mockedExecSafe.mockReturnValue({ ok: true, stdout: '', stderr: '' });

    clearStaleActivation('my-project');

    const cmd = mockedExecSafe.mock.calls[0]![0];
    expect(cmd).toMatch(/^docker run --rm/);
    expect(cmd).toContain('alpine');
  });

  it('returns false on failure without throwing', () => {
    mockedExecSafe.mockReturnValue({ ok: false, stdout: '', stderr: 'docker not available' });

    expect(clearStaleActivation('my-project')).toBe(false);
  });
});
