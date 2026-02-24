import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

// Stable mock logger instance — same object returned by every getLogger() call
const mockLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock the logger — return the same stable instance every time
vi.mock('../../cli/utils/logger.js', () => ({
  getLogger: () => mockLogger,
}));

// Import after mocks are set up
const { execSync, spawn } = await import('node:child_process');
const { exec, execSafe, spawnBackground } = await import('../../cli/utils/exec.js');

const mockExecSync = execSync as Mock;
const mockSpawn = spawn as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('exec', () => {
  it('returns trimmed stdout for a successful command', () => {
    mockExecSync.mockReturnValue('  hello world  \n');

    const result = exec('echo hello');

    expect(result).toBe('hello world');
  });

  it('passes cwd, env, and timeout options to execSync', () => {
    mockExecSync.mockReturnValue('ok');

    exec('ls', { cwd: '/tmp', env: { FOO: 'bar' }, timeout: 5000 });

    expect(mockExecSync).toHaveBeenCalledWith('ls', {
      encoding: 'utf-8',
      cwd: '/tmp',
      env: expect.objectContaining({ FOO: 'bar' }),
      timeout: 5000,
      stdio: 'pipe',
    });
  });

  it('merges env with process.env', () => {
    mockExecSync.mockReturnValue('ok');

    exec('cmd', { env: { CUSTOM_VAR: 'value' } });

    const callArgs = mockExecSync.mock.calls[0]![1] as { env: Record<string, string> };
    expect(callArgs.env).toHaveProperty('CUSTOM_VAR', 'value');
    // Should also have existing process.env keys
    expect(callArgs.env).toHaveProperty('PATH');
  });

  it('passes undefined env when no env option provided', () => {
    mockExecSync.mockReturnValue('ok');

    exec('cmd');

    const callArgs = mockExecSync.mock.calls[0]![1] as { env: undefined };
    expect(callArgs.env).toBeUndefined();
  });

  it('uses inherit stdio when specified', () => {
    mockExecSync.mockReturnValue('ok');

    exec('cmd', { stdio: 'inherit' });

    const callArgs = mockExecSync.mock.calls[0]![1] as { stdio: string };
    expect(callArgs.stdio).toBe('inherit');
  });

  it('uses pipe stdio by default', () => {
    mockExecSync.mockReturnValue('ok');

    exec('cmd');

    const callArgs = mockExecSync.mock.calls[0]![1] as { stdio: string };
    expect(callArgs.stdio).toBe('pipe');
  });

  it('throws on non-zero exit code', () => {
    const error = new Error('Command failed: bad-cmd');
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    expect(() => exec('bad-cmd')).toThrow('Command failed: bad-cmd');
  });

  it('logs at debug level before execution', () => {
    mockExecSync.mockReturnValue('ok');

    exec('echo hi', { cwd: '/home' });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      { cmd: 'echo hi', cwd: '/home' },
      'exec',
    );
  });

  it('logs at error level on failure before re-throwing', () => {
    const error = new Error('fail');
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    expect(() => exec('bad-cmd')).toThrow();

    expect(mockLogger.error).toHaveBeenCalledWith(
      { cmd: 'bad-cmd', error: String(error) },
      'Command failed',
    );
  });
});

describe('execSafe', () => {
  it('returns ok: true with stdout on success', () => {
    mockExecSync.mockReturnValue('  output  \n');

    const result = execSafe('echo hello');

    expect(result).toEqual({ ok: true, stdout: 'output', stderr: '' });
  });

  it('returns ok: false with stderr on failure without throwing', () => {
    const error = Object.assign(new Error('fail'), {
      stdout: '',
      stderr: 'something went wrong',
    });
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    const result = execSafe('bad-cmd');

    expect(result).toEqual({
      ok: false,
      stdout: '',
      stderr: 'something went wrong',
    });
  });

  it('handles Buffer stdout/stderr in error', () => {
    const error = Object.assign(new Error('fail'), {
      stdout: Buffer.from('partial output'),
      stderr: Buffer.from('error message'),
    });
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    const result = execSafe('bad-cmd');

    expect(result).toEqual({
      ok: false,
      stdout: 'partial output',
      stderr: 'error message',
    });
  });

  it('handles missing stdout/stderr in error', () => {
    const error = new Error('fail');
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    const result = execSafe('bad-cmd');

    expect(result).toEqual({ ok: false, stdout: '', stderr: '' });
  });

  it('passes cwd, env, and timeout options to execSync', () => {
    mockExecSync.mockReturnValue('ok');

    execSafe('ls', { cwd: '/tmp', env: { BAR: 'baz' }, timeout: 3000 });

    expect(mockExecSync).toHaveBeenCalledWith('ls', {
      encoding: 'utf-8',
      cwd: '/tmp',
      env: expect.objectContaining({ BAR: 'baz' }),
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('always uses pipe stdio for all three streams', () => {
    mockExecSync.mockReturnValue('ok');

    execSafe('cmd', { stdio: 'inherit' });

    const callArgs = mockExecSync.mock.calls[0]![1] as { stdio: string[] };
    // execSafe always uses pipe for all streams regardless of the stdio option
    expect(callArgs.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('logs at debug level before execution', () => {
    mockExecSync.mockReturnValue('ok');

    execSafe('echo hi', { cwd: '/tmp' });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      { cmd: 'echo hi', cwd: '/tmp' },
      'execSafe',
    );
  });

  it('does not log at error level on failure', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fail');
    });

    execSafe('bad-cmd');

    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe('spawnBackground', () => {
  function createMockChildProcess(): ChildProcess {
    return {
      unref: vi.fn(),
      pid: 12345,
      stdin: null,
      stdout: null,
      stderr: null,
      stdio: [null, null, null, null, null],
      connected: false,
      exitCode: null,
      signalCode: null,
      spawnargs: [],
      spawnfile: '',
      killed: false,
      kill: vi.fn(),
      send: vi.fn(),
      disconnect: vi.fn(),
      ref: vi.fn(),
      addListener: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      prependListener: vi.fn(),
      prependOnceListener: vi.fn(),
      removeListener: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
      setMaxListeners: vi.fn(),
      getMaxListeners: vi.fn(),
      listeners: vi.fn(),
      rawListeners: vi.fn(),
      listenerCount: vi.fn(),
      eventNames: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as ChildProcess;
  }

  it('returns a ChildProcess', () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const child = spawnBackground('node', ['server.js']);

    expect(child).toBe(mockChild);
  });

  it('calls spawn with correct command and args', () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    spawnBackground('firebase', ['emulators:start']);

    expect(mockSpawn).toHaveBeenCalledWith(
      'firebase',
      ['emulators:start'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      }),
    );
  });

  it('defaults to detached: true and stdio: ignore', () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    spawnBackground('cmd', ['arg']);

    const callArgs = mockSpawn.mock.calls[0]![2] as SpawnOptions;
    expect(callArgs.detached).toBe(true);
    expect(callArgs.stdio).toBe('ignore');
  });

  it('allows overriding spawn options', () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    spawnBackground('cmd', ['arg'], {
      cwd: '/app',
      env: { NODE_ENV: 'production' },
      stdio: 'pipe',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'cmd',
      ['arg'],
      expect.objectContaining({
        detached: true,
        cwd: '/app',
        env: { NODE_ENV: 'production' },
        stdio: 'pipe',
      }),
    );
  });

  it('calls unref on the child process', () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    spawnBackground('cmd', ['arg']);

    expect(mockChild.unref).toHaveBeenCalled();
  });

  it('logs at debug level with command, args, and cwd', () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    spawnBackground('npx', ['tsx', 'watch'], { cwd: '/app' });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      { cmd: 'npx', args: ['tsx', 'watch'], cwd: '/app' },
      'spawnBackground',
    );
  });
});
