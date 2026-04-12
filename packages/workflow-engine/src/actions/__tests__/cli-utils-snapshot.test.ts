/**
 * Snapshot tests for executeCommand / executeShellCommand spawn call composition.
 *
 * Verifies that:
 * - When a launcher is registered, spawn calls route through it with correct args
 * - When no launcher is registered, direct child_process.spawn is used (fallback)
 * - detached: true and process-group kill semantics are preserved in both paths
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { executeCommand, executeShellCommand } from '../cli-utils.js';
import {
  registerProcessLauncher,
  clearProcessLauncher,
  type LaunchFunctionRequest,
  type LaunchFunctionHandle,
} from '../process-launcher.js';

/** Captured spawn call from the recording launcher */
interface RecordedLaunch {
  request: LaunchFunctionRequest;
}

/**
 * Inline recording launcher — captures LaunchFunctionRequest and returns a
 * dummy handle that immediately exits with the configured code.
 */
function createRecordingLauncher(exitCode = 0) {
  const calls: RecordedLaunch[] = [];

  const launcher = (request: LaunchFunctionRequest): LaunchFunctionHandle => {
    calls.push({ request });

    const stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;

    const exitPromise = Promise.resolve(exitCode);

    return {
      stdout,
      stderr,
      pid: 99999,
      kill: () => true,
      exitPromise,
    };
  };

  return { launcher, calls };
}

describe('executeCommand spawn composition (launcher path)', () => {
  let recording: ReturnType<typeof createRecordingLauncher>;

  beforeEach(() => {
    clearProcessLauncher();
    recording = createRecordingLauncher(0);
    registerProcessLauncher(recording.launcher);
  });

  afterEach(() => {
    clearProcessLauncher();
  });

  it('should route through registered launcher with kind: generic-subprocess', async () => {
    await executeCommand('node', ['--version'], { cwd: '/tmp' });

    expect(recording.calls).toHaveLength(1);
    const { request } = recording.calls[0];
    expect(request.kind).toBe('generic-subprocess');
    expect(request.command).toBe('node');
    expect(request.args).toEqual(['--version']);
    expect(request.cwd).toBe('/tmp');
    expect(request.detached).toBe(true);
  });

  it('should forward env overrides to launcher', async () => {
    await executeCommand('echo', ['hi'], {
      cwd: '/tmp',
      env: { FOO: 'bar' },
    });

    const { request } = recording.calls[0];
    expect(request.env).toEqual({ FOO: 'bar' });
  });

  it('should forward signal to launcher', async () => {
    const controller = new AbortController();
    await executeCommand('echo', ['hi'], {
      cwd: '/tmp',
      signal: controller.signal,
    });

    const { request } = recording.calls[0];
    expect(request.signal).toBe(controller.signal);
  });

  it('should return correct exit code from launcher handle', async () => {
    clearProcessLauncher();
    const rec = createRecordingLauncher(42);
    registerProcessLauncher(rec.launcher);

    const result = await executeCommand('failing-cmd', [], { cwd: '/tmp' });
    expect(result.exitCode).toBe(42);
  });

  it('snapshot: executeCommand launcher request', async () => {
    await executeCommand('git', ['status', '--porcelain'], {
      cwd: '/workspace',
      env: { GIT_TERMINAL_PROMPT: '0' },
    });

    expect(recording.calls[0].request).toMatchSnapshot();
  });
});

describe('executeShellCommand spawn composition (launcher path)', () => {
  let recording: ReturnType<typeof createRecordingLauncher>;

  beforeEach(() => {
    clearProcessLauncher();
    recording = createRecordingLauncher(0);
    registerProcessLauncher(recording.launcher);
  });

  afterEach(() => {
    clearProcessLauncher();
  });

  it('should route through registered launcher with kind: shell', async () => {
    await executeShellCommand('echo hello | wc -c', { cwd: '/tmp' });

    expect(recording.calls).toHaveLength(1);
    const { request } = recording.calls[0];
    expect(request.kind).toBe('shell');
    expect(request.command).toBe('echo hello | wc -c');
    expect(request.args).toEqual([]);
    expect(request.cwd).toBe('/tmp');
    expect(request.detached).toBe(true);
  });

  it('should forward env overrides to launcher', async () => {
    await executeShellCommand('ls', {
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
    });

    const { request } = recording.calls[0];
    expect(request.env).toEqual({ PATH: '/usr/bin' });
  });

  it('snapshot: executeShellCommand launcher request', async () => {
    await executeShellCommand('npm run build 2>&1', {
      cwd: '/workspace',
      env: { NODE_ENV: 'production' },
    });

    expect(recording.calls[0].request).toMatchSnapshot();
  });
});

describe('executeCommand fallback path (no launcher)', () => {
  beforeEach(() => {
    clearProcessLauncher();
  });

  it('should use direct spawn when no launcher registered', async () => {
    const result = await executeCommand('echo', ['fallback works']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('fallback works\n');
  });

  it('should preserve process-group kill on timeout', async () => {
    const result = await executeCommand('sleep', ['10'], { timeout: 100 });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('Process killed due to timeout');
  });
});

describe('executeShellCommand fallback path (no launcher)', () => {
  beforeEach(() => {
    clearProcessLauncher();
  });

  it('should use direct spawn when no launcher registered', async () => {
    const result = await executeShellCommand('echo "shell fallback"');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('shell fallback\n');
  });

  it('should preserve process-group kill on timeout', async () => {
    const result = await executeShellCommand('sleep 10', { timeout: 100 });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('Process killed due to timeout');
  });
});

describe('abort signal handling', () => {
  beforeEach(() => {
    clearProcessLauncher();
  });

  it('executeCommand should return immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeCommand('sleep', ['10'], {
      signal: controller.signal,
    });

    expect(result.exitCode).toBe(130);
    expect(result.stderr).toBe('Aborted before start');
  });

  it('executeShellCommand should return immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeShellCommand('sleep 10', {
      signal: controller.signal,
    });

    expect(result.exitCode).toBe(130);
    expect(result.stderr).toBe('Aborted before start');
  });
});
