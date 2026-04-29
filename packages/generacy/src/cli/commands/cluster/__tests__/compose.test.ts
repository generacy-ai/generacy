import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClusterContext } from '../context.js';

vi.mock('../../../utils/exec.js', () => ({
  execSafe: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { dockerComposeArgs, runCompose } from '../compose.js';
import { execSafe } from '../../../utils/exec.js';

const mockCtx: ClusterContext = {
  projectRoot: '/projects/my-app',
  generacyDir: '/projects/my-app/.generacy',
  composePath: '/projects/my-app/.generacy/docker-compose.yml',
  clusterConfig: { channel: 'stable', workers: 1, variant: 'standard' },
  clusterIdentity: null,
  projectName: 'my-app',
};

describe('dockerComposeArgs', () => {
  it('returns correct --project-name and --file args', () => {
    const args = dockerComposeArgs(mockCtx);

    expect(args).toEqual([
      '--project-name=my-app',
      '--file=/projects/my-app/.generacy/docker-compose.yml',
    ]);
  });
});

describe('runCompose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls execSafe with correct full command string', () => {
    vi.mocked(execSafe).mockReturnValue({ ok: true, stdout: '', stderr: '' });

    runCompose(mockCtx, ['ps']);

    expect(execSafe).toHaveBeenCalledWith(
      'docker compose --project-name=my-app --file=/projects/my-app/.generacy/docker-compose.yml ps',
    );
  });

  it('passes subcommand args (e.g. up -d)', () => {
    vi.mocked(execSafe).mockReturnValue({ ok: true, stdout: '', stderr: '' });

    runCompose(mockCtx, ['up', '-d']);

    expect(execSafe).toHaveBeenCalledWith(
      'docker compose --project-name=my-app --file=/projects/my-app/.generacy/docker-compose.yml up -d',
    );
  });

  it('returns the ExecResult from execSafe', () => {
    const expected = { ok: false, stdout: '', stderr: 'error occurred' };
    vi.mocked(execSafe).mockReturnValue(expected);

    const result = runCompose(mockCtx, ['down']);

    expect(result).toBe(expected);
  });

  it('includes all args in correct order', () => {
    vi.mocked(execSafe).mockReturnValue({ ok: true, stdout: '', stderr: '' });

    runCompose(mockCtx, ['down', '--volumes']);

    const cmd = vi.mocked(execSafe).mock.calls[0][0];
    const parts = cmd.split(' ');

    expect(parts[0]).toBe('docker');
    expect(parts[1]).toBe('compose');
    expect(parts[2]).toBe('--project-name=my-app');
    expect(parts[3]).toBe('--file=/projects/my-app/.generacy/docker-compose.yml');
    expect(parts[4]).toBe('down');
    expect(parts[5]).toBe('--volumes');
  });
});
