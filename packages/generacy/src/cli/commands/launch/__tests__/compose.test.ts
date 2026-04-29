import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execSync, spawn } from 'node:child_process';

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { pullImage, startCluster, streamLogsUntilActivation } from '../compose.js';

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
