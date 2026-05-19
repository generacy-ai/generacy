import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: execSafe from cli/utils/exec
// ---------------------------------------------------------------------------

vi.mock('../../../utils/exec.js', () => ({
  execSafe: vi.fn(),
}));

import { execSafe } from '../../../utils/exec.js';
import { ensureDocker } from '../docker.js';

const mockedExecSafe = vi.mocked(execSafe);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureDocker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Success: Docker Compose available
  // -------------------------------------------------------------------------

  it('does not throw when Docker Compose is available', () => {
    mockedExecSafe.mockReturnValue({
      ok: true,
      stdout: 'Docker Compose version v2.24.5',
      stderr: '',
    });

    expect(() => ensureDocker()).not.toThrow();
    expect(mockedExecSafe).toHaveBeenCalledWith('docker compose version');
  });

  // -------------------------------------------------------------------------
  // Failure: Docker Compose not installed
  // -------------------------------------------------------------------------

  it('throws "not installed" message when command not found', () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr: 'docker: command not found',
    });

    expect(() => ensureDocker()).toThrow(
      'Docker Compose is not installed or not in PATH. Install Docker Desktop from https://docker.com',
    );
  });

  it('throws "not installed" message when "is not recognized"', () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr: "'docker' is not recognized as an internal or external command",
    });

    expect(() => ensureDocker()).toThrow(
      'Docker Compose is not installed or not in PATH. Install Docker Desktop from https://docker.com',
    );
  });

  it('throws "not installed" message when "no such file"', () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr: 'no such file or directory',
    });

    expect(() => ensureDocker()).toThrow(
      'Docker Compose is not installed or not in PATH. Install Docker Desktop from https://docker.com',
    );
  });

  // -------------------------------------------------------------------------
  // Failure: Docker daemon not running
  // -------------------------------------------------------------------------

  it('throws "daemon is not running" when cannot connect to daemon', () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr:
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    });

    expect(() => ensureDocker()).toThrow(
      'Docker daemon is not running. Start Docker and try again.',
    );
  });

  // -------------------------------------------------------------------------
  // Failure: Unknown error
  // -------------------------------------------------------------------------

  it('throws generic failure message for unknown errors', () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr: 'some completely unexpected error',
    });

    expect(() => ensureDocker()).toThrow(
      'Docker Compose check failed: some completely unexpected error',
    );
  });

  it('uses stdout in generic failure message when stderr is empty', () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: 'unexpected stdout output',
      stderr: '',
    });

    expect(() => ensureDocker()).toThrow(
      'Docker Compose check failed: unexpected stdout output',
    );
  });
});
