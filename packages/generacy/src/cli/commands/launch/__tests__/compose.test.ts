import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock node:fs
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedRmSync = vi.mocked(rmSync);

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { pullImage, startCluster, streamLogsUntilActivation } from '../compose.js';
import type { RegistryCredential } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockChildProcess() {
  const cp = new EventEmitter() as any;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.killed = false;
  cp.kill = vi.fn(() => {
    cp.killed = true;
  });
  return cp;
}

// ---------------------------------------------------------------------------
// pullImage
// ---------------------------------------------------------------------------

describe('pullImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs docker compose pull successfully', () => {
    mockedExecSync.mockReturnValue(Buffer.from(''));

    expect(() => pullImage('/project')).not.toThrow();

    expect(mockedExecSync).toHaveBeenCalledWith(
      'docker compose -f .generacy/docker-compose.yml pull',
      { cwd: '/project', stdio: 'pipe' },
    );
  });

  it('throws a descriptive error when docker compose pull fails', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('exit code 1');
    });

    expect(() => pullImage('/project')).toThrow('docker compose pull failed: exit code 1');
  });
});

// ---------------------------------------------------------------------------
// pullImage — registry credentials
// ---------------------------------------------------------------------------

describe('pullImage with registryCredentials', () => {
  const creds: RegistryCredential[] = [
    { host: 'ghcr.io', username: 'myuser', password: 'mytoken' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-creds path calls execSync without DOCKER_CONFIG env override', () => {
    mockedExecSync.mockReturnValue(Buffer.from(''));

    pullImage('/project');

    expect(mockedExecSync).toHaveBeenCalledWith(
      'docker compose -f .generacy/docker-compose.yml pull',
      { cwd: '/project', stdio: 'pipe' },
    );
    expect(mockedMkdirSync).not.toHaveBeenCalled();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it('with-creds path writes scoped config.json with correct base64 auth and passes DOCKER_CONFIG', () => {
    mockedExecSync.mockReturnValue(Buffer.from(''));

    pullImage('/project', creds);

    // Should create the .docker dir
    expect(mockedMkdirSync).toHaveBeenCalledWith('/project/.docker', { recursive: true });

    // Should write config.json with correct auth
    const expectedAuth = Buffer.from('myuser:mytoken').toString('base64');
    const expectedConfig = JSON.stringify({
      auths: { 'ghcr.io': { auth: expectedAuth } },
    });
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      '/project/.docker/config.json',
      expectedConfig,
      { mode: 0o600 },
    );

    // Should pass DOCKER_CONFIG env to execSync
    expect(mockedExecSync).toHaveBeenCalledWith(
      'docker compose -f .generacy/docker-compose.yml pull',
      expect.objectContaining({
        cwd: '/project',
        stdio: 'pipe',
        env: expect.objectContaining({ DOCKER_CONFIG: '/project/.docker' }),
      }),
    );
  });

  it('scoped config directory is removed after successful pull', () => {
    mockedExecSync.mockReturnValue(Buffer.from(''));

    pullImage('/project', creds);

    expect(mockedRmSync).toHaveBeenCalledWith('/project/.docker', { recursive: true, force: true });
  });

  it('scoped config directory is removed even when pull throws', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('exit code 1');
    });

    expect(() => pullImage('/project', creds)).toThrow();

    expect(mockedRmSync).toHaveBeenCalledWith('/project/.docker', { recursive: true, force: true });
  });

  it('401 stderr pattern produces auth-failure error message', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('unauthorized: authentication required');
    });

    expect(() => pullImage('/project', creds)).toThrow(
      /Registry authentication failed/,
    );
  });

  it('404 stderr pattern produces image-not-found error message', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('manifest unknown: not found');
    });

    expect(() => pullImage('/project', creds)).toThrow(
      /Image not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// startCluster
// ---------------------------------------------------------------------------

describe('startCluster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs docker compose up -d successfully', () => {
    mockedExecSync.mockReturnValue(Buffer.from(''));

    expect(() => startCluster('/project')).not.toThrow();

    expect(mockedExecSync).toHaveBeenCalledWith(
      'docker compose -f .generacy/docker-compose.yml up -d',
      { cwd: '/project', stdio: 'pipe' },
    );
  });

  it('throws a descriptive error when docker compose up fails', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('exit code 1');
    });

    expect(() => startCluster('/project')).toThrow('docker compose up failed: exit code 1');
  });
});

// ---------------------------------------------------------------------------
// streamLogsUntilActivation
// ---------------------------------------------------------------------------

describe('streamLogsUntilActivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts verificationUri from "Go to:" pattern', async () => {
    const mockChild = createMockChildProcess();
    mockedSpawn.mockReturnValue(mockChild);

    const promise = streamLogsUntilActivation('/project', 5000);

    // Emit both patterns in a single chunk
    mockChild.stdout.emit(
      'data',
      Buffer.from('Go to: https://example.com/verify\nEnter code: ABCD-1234\n'),
    );

    const result = await promise;
    expect(result.verificationUri).toBe('https://example.com/verify');
  });

  it('extracts userCode from "Enter code:" pattern', async () => {
    const mockChild = createMockChildProcess();
    mockedSpawn.mockReturnValue(mockChild);

    const promise = streamLogsUntilActivation('/project', 5000);

    mockChild.stdout.emit(
      'data',
      Buffer.from('Go to: https://example.com/verify\nEnter code: ABCD-1234\n'),
    );

    const result = await promise;
    expect(result.userCode).toBe('ABCD-1234');
  });

  it('does not include trailing JSON-escaped newline in extracted URL', async () => {
    // The orchestrator's pino logger emits its activation message as JSON
    // where embedded newlines are encoded as literal \n (backslash-n).
    // The regex must NOT capture the trailing two-character escape sequence.
    const mockChild = createMockChildProcess();
    mockedSpawn.mockReturnValue(mockChild);

    const promise = streamLogsUntilActivation('/project', 5000);

    mockChild.stdout.emit(
      'data',
      Buffer.from(
        // Realistic JSON log line as docker compose logs would surface it:
        '{"level":30,"msg":"  Go to: https://staging.generacy.ai/cluster-activate\\n  Enter code: ABCD-1234\\n"}\n',
      ),
    );

    const result = await promise;
    expect(result.verificationUri).toBe('https://staging.generacy.ai/cluster-activate');
    expect(result.userCode).toBe('ABCD-1234');
  });

  it('resolves when both patterns are matched', async () => {
    const mockChild = createMockChildProcess();
    mockedSpawn.mockReturnValue(mockChild);

    const promise = streamLogsUntilActivation('/project', 5000);

    // Send patterns across separate chunks
    mockChild.stdout.emit('data', Buffer.from('Go to: https://example.com/verify\n'));
    mockChild.stdout.emit('data', Buffer.from('Enter code: ABCD-1234\n'));

    const result = await promise;
    expect(result).toEqual({
      verificationUri: 'https://example.com/verify',
      userCode: 'ABCD-1234',
    });
    expect(mockChild.kill).toHaveBeenCalled();
  });

  it('rejects on timeout when patterns are never matched', async () => {
    const mockChild = createMockChildProcess();
    mockedSpawn.mockReturnValue(mockChild);

    await expect(streamLogsUntilActivation('/project', 100)).rejects.toThrow(
      'Timed out after 100ms waiting for activation URL',
    );
  });

  it('handles partial lines correctly', async () => {
    const mockChild = createMockChildProcess();
    mockedSpawn.mockReturnValue(mockChild);

    const promise = streamLogsUntilActivation('/project', 5000);

    // Send a partial line first (no trailing newline)
    mockChild.stdout.emit('data', Buffer.from('Go to: https://exa'));
    // Complete the line and send the second pattern
    mockChild.stdout.emit(
      'data',
      Buffer.from('mple.com/verify\nEnter code: ABCD-1234\n'),
    );

    const result = await promise;
    expect(result).toEqual({
      verificationUri: 'https://example.com/verify',
      userCode: 'ABCD-1234',
    });
  });
});
