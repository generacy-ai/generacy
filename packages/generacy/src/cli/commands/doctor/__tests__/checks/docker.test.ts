import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Mock: execSafe from cli/utils/exec
// ---------------------------------------------------------------------------

vi.mock('../../../../utils/exec.js', () => ({
  execSafe: vi.fn(),
}));

import { execSafe } from '../../../../utils/exec.js';
import { dockerCheck } from '../../checks/docker.js';

const mockedExecSafe = vi.mocked(execSafe);

function makeContext(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    configPath: null,
    config: null,
    envVars: null,
    inDevContainer: false,
    verbose: false,
    projectRoot: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dockerCheck', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('has correct metadata', () => {
    expect(dockerCheck.id).toBe('docker');
    expect(dockerCheck.category).toBe('system');
    expect(dockerCheck.dependencies).toEqual([]);
    expect(dockerCheck.priority).toBe('P1');
  });

  // -------------------------------------------------------------------------
  // Failure: Docker not installed
  // -------------------------------------------------------------------------

  it('fails when Docker is not installed (command not found)', async () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr: 'docker: command not found',
    });

    const result = await dockerCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toBe('Docker is not installed');
    expect(result.suggestion).toContain('https://docker.com');
    expect(result.detail).toBeTruthy();
  });

  it('fails when Docker is not installed (not recognized)', async () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr: "'docker' is not recognized as an internal or external command",
    });

    const result = await dockerCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toBe('Docker is not installed');
  });

  it('fails when Docker is not installed (no such file)', async () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr: 'no such file or directory',
    });

    const result = await dockerCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toBe('Docker is not installed');
  });

  // -------------------------------------------------------------------------
  // Failure: Docker daemon not running
  // -------------------------------------------------------------------------

  it('fails when Docker daemon is not running', async () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr:
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    });

    const result = await dockerCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toBe('Docker daemon is not running');
    expect(result.suggestion).toContain('Start Docker Desktop');
    expect(result.detail).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Failure: Permission denied
  // -------------------------------------------------------------------------

  it('fails when user lacks Docker permissions', async () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr:
        "Got permission denied while trying to connect to the Docker daemon socket",
    });

    const result = await dockerCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toBe('Insufficient permissions to access Docker');
    expect(result.suggestion).toContain('sudo usermod -aG docker $USER');
    expect(result.detail).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Failure: Unknown error
  // -------------------------------------------------------------------------

  it('fails with generic message for unknown error', async () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr: 'some completely unexpected error',
    });

    const result = await dockerCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toBe('Docker check failed');
    expect(result.suggestion).toContain('docker info');
  });

  // -------------------------------------------------------------------------
  // Success: version extraction
  // -------------------------------------------------------------------------

  it('passes and extracts Docker version from stdout', async () => {
    mockedExecSafe.mockReturnValue({
      ok: true,
      stdout: [
        'Client:',
        ' Version:    27.0.3',
        'Server:',
        ' Server Version: 27.0.3',
        ' Storage Driver: overlay2',
      ].join('\n'),
      stderr: '',
    });

    const result = await dockerCheck.run(makeContext());

    expect(result.status).toBe('pass');
    expect(result.message).toBe('Docker daemon is running (v27.0.3)');
    expect(result.detail).toBe('Server Version: 27.0.3');
  });

  it('passes without version when version line is missing', async () => {
    mockedExecSafe.mockReturnValue({
      ok: true,
      stdout: 'Client:\n Server: running\n Storage Driver: overlay2',
      stderr: '',
    });

    const result = await dockerCheck.run(makeContext());

    expect(result.status).toBe('pass');
    expect(result.message).toBe('Docker daemon is running');
    expect(result.detail).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Error output priority (stderr preferred over stdout)
  // -------------------------------------------------------------------------

  it('uses stderr for detail when both stdout and stderr are present', async () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: 'stdout content',
      stderr: 'docker: command not found',
    });

    const result = await dockerCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.detail).toBe('docker: command not found');
  });

  it('falls back to stdout for detail when stderr is empty', async () => {
    mockedExecSafe.mockReturnValue({
      ok: false,
      stdout: 'not found',
      stderr: '',
    });

    const result = await dockerCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.detail).toBe('not found');
  });
});
