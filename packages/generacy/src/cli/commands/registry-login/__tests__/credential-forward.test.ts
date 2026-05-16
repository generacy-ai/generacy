import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClusterContext } from '../../cluster/context.js';

vi.mock('../../../utils/exec.js', () => ({
  execSafe: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { isClusterRunning, forwardCredential, removeCredential } from '../credential-forward.js';
import { execSafe } from '../../../utils/exec.js';

const mockCtx: ClusterContext = {
  projectRoot: '/projects/my-app',
  generacyDir: '/projects/my-app/.generacy',
  composePath: '/projects/my-app/.generacy/docker-compose.yml',
  clusterConfig: { channel: 'stable', workers: 1, variant: 'cluster-base' },
  clusterIdentity: null,
  projectName: 'my-app',
};

describe('credential-forward', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isClusterRunning', () => {
    it('returns true when compose ps returns output', () => {
      vi.mocked(execSafe).mockReturnValue({ ok: true, stdout: '[{"Name":"orchestrator"}]', stderr: '' });
      expect(isClusterRunning(mockCtx)).toBe(true);
    });

    it('returns false when compose ps returns empty', () => {
      vi.mocked(execSafe).mockReturnValue({ ok: true, stdout: '', stderr: '' });
      expect(isClusterRunning(mockCtx)).toBe(false);
    });

    it('returns false when compose ps fails', () => {
      vi.mocked(execSafe).mockReturnValue({ ok: false, stdout: '', stderr: 'error' });
      expect(isClusterRunning(mockCtx)).toBe(false);
    });

    it('calls docker compose ps with correct args', () => {
      vi.mocked(execSafe).mockReturnValue({ ok: true, stdout: '', stderr: '' });
      isClusterRunning(mockCtx);
      expect(execSafe).toHaveBeenCalledWith(
        expect.stringContaining('docker compose --project-name=my-app --file=/projects/my-app/.generacy/docker-compose.yml ps --format json'),
      );
    });
  });

  describe('forwardCredential', () => {
    it('calls docker compose exec with PUT and correct URL', () => {
      vi.mocked(execSafe).mockReturnValue({ ok: true, stdout: '', stderr: '' });
      forwardCredential(mockCtx, 'ghcr.io', 'user', 'token');
      const cmd = vi.mocked(execSafe).mock.calls[0][0];
      expect(cmd).toContain('exec');
      expect(cmd).toContain('orchestrator');
      expect(cmd).toContain('curl');
      expect(cmd).toContain('-X PUT');
      expect(cmd).toContain('--unix-socket');
      expect(cmd).toContain('/run/generacy-control-plane/control.sock');
      expect(cmd).toContain('http://localhost/credentials/registry-ghcr.io');
    });

    it('includes JSON body with type docker-registry', () => {
      vi.mocked(execSafe).mockReturnValue({ ok: true, stdout: '', stderr: '' });
      forwardCredential(mockCtx, 'ghcr.io', 'user', 'token');
      const cmd = vi.mocked(execSafe).mock.calls[0][0];
      expect(cmd).toContain('docker-registry');
      expect(cmd).toContain('user');
      expect(cmd).toContain('token');
    });

    it('returns ExecResult from execSafe', () => {
      const expected = { ok: false, stdout: '', stderr: 'connection refused' };
      vi.mocked(execSafe).mockReturnValue(expected);
      const result = forwardCredential(mockCtx, 'ghcr.io', 'user', 'token');
      expect(result).toBe(expected);
    });
  });

  describe('removeCredential', () => {
    it('calls docker compose exec with DELETE and correct URL', () => {
      vi.mocked(execSafe).mockReturnValue({ ok: true, stdout: '', stderr: '' });
      removeCredential(mockCtx, 'ghcr.io');
      const cmd = vi.mocked(execSafe).mock.calls[0][0];
      expect(cmd).toContain('exec');
      expect(cmd).toContain('orchestrator');
      expect(cmd).toContain('curl');
      expect(cmd).toContain('-X DELETE');
      expect(cmd).toContain('http://localhost/credentials/registry-ghcr.io');
    });

    it('returns ExecResult from execSafe', () => {
      const expected = { ok: true, stdout: '{}', stderr: '' };
      vi.mocked(execSafe).mockReturnValue(expected);
      const result = removeCredential(mockCtx, 'ghcr.io');
      expect(result).toBe(expected);
    });
  });
});
