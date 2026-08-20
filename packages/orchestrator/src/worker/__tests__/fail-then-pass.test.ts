import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #1134 T009 (US3 / SC-004) + #1150 review remediation
//
// Exercises runFailThenPass by mocking node:child_process execFile and the
// node:fs/promises helpers. Each git / pnpm invocation is routed through a
// controllable handler so we can drive the base-ref install, base run, and
// branch run independently, assert cleanup happens even on the error path, and
// assert the branch's test files are overlaid onto the base worktree — all
// without real git worktrees, pnpm installs, or filesystem writes.
// ---------------------------------------------------------------------------

interface ExecOutcome {
  ok: boolean;
  stdout?: string;
  stderr?: string;
}

// Routed synchronously by the mock; each test installs its own implementation.
let handler: (cmd: string, args: string[]) => ExecOutcome;
const execFileSpy = vi.fn((cmd: string, args: string[], _opts: unknown, cb: unknown) => {
  const callback = cb as (err: unknown, res?: { stdout: string; stderr: string }) => void;
  const r = handler(cmd, args);
  if (r.ok) {
    callback(null, { stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
  } else {
    const err = new Error('command failed') as Error & { stdout?: string; stderr?: string };
    err.stdout = r.stdout ?? '';
    err.stderr = r.stderr ?? '';
    callback(err);
  }
});

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFileSpy as unknown as (...a: unknown[]) => void)(...args),
}));

// Stub the fs helpers so the overlay + temp-dir setup never touch the disk.
const mkdirSpy = vi.fn(async () => undefined);
const copyFileSpy = vi.fn(async () => undefined);
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}XXXX`),
  mkdir: (...args: unknown[]) => (mkdirSpy as unknown as (...a: unknown[]) => Promise<void>)(...args),
  copyFile: (...args: unknown[]) =>
    (copyFileSpy as unknown as (...a: unknown[]) => Promise<void>)(...args),
}));

const { runFailThenPass } = await import('../fail-then-pass.js');

const BASE_REF = 'origin/develop';
const CHECKOUT = '/tmp/checkout';

function isWorktreeAdd(cmd: string, args: string[]): boolean {
  return cmd === 'git' && args[0] === 'worktree' && args[1] === 'add';
}
function isWorktreeRemove(cmd: string, args: string[]): boolean {
  return cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove';
}
function isPnpmInstall(cmd: string, args: string[]): boolean {
  return cmd === 'pnpm' && args[0] === 'install';
}
function isVitest(cmd: string, args: string[]): boolean {
  return cmd === 'pnpm' && args[0] === 'vitest';
}

describe('runFailThenPass (#1134 T009 / #1150)', () => {
  beforeEach(() => {
    execFileSpy.mockClear();
    mkdirSpy.mockClear();
    copyFileSpy.mockClear();
    handler = () => ({ ok: true });
  });

  it('empty changed test set → noop and no worktree created', async () => {
    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: [],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: 'noop' });
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it('base-fails + branch-passes → pass, installs deps and overlays branch test files', async () => {
    let vitestCalls = 0;
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true, stdout: 'installed' };
      if (isVitest(cmd, args)) {
        vitestCalls += 1;
        // First vitest run = base (fail), second = branch (pass).
        return vitestCalls === 1 ? { ok: false, stdout: 'base red' } : { ok: true, stdout: 'branch green' };
      }
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: 'pass' });
    // base run + branch run (install is a separate pnpm invocation).
    expect(vitestCalls).toBe(2);
    // Dependencies installed in the base worktree.
    expect(execFileSpy.mock.calls.some(([c, a]) => isPnpmInstall(c as string, a as string[]))).toBe(
      true,
    );
    // Branch test file overlaid onto the base worktree.
    expect(copyFileSpy).toHaveBeenCalledTimes(1);
    // worktree cleaned up.
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreeRemove(c as string, a as string[]))).toBe(
      true,
    );
  });

  it('base-ref dependency install fails → non-blocking skip, no vitest run', async () => {
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: false, stderr: 'ERR_PNPM_NO_OFFLINE_META' };
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe('skip');
    if (result.kind === 'skip') {
      expect(result.reason).toContain('install dependencies');
      expect(result.reason).toContain('ERR_PNPM_NO_OFFLINE_META');
    }
    // No vitest run happened, but the worktree was still cleaned up.
    expect(execFileSpy.mock.calls.some(([c, a]) => isVitest(c as string, a as string[]))).toBe(false);
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreeRemove(c as string, a as string[]))).toBe(
      true,
    );
  });

  it('base-passes (against base source) → fail with reason base-passed and evidence', async () => {
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true };
      if (isVitest(cmd, args)) return { ok: true, stdout: 'base unexpectedly green' };
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe('fail');
    if (result.kind === 'fail') {
      expect(result.reason).toBe('base-passed');
      expect(result.evidence).toContain(BASE_REF);
      expect(result.evidence).toContain('base unexpectedly green');
    }
    // worktree cleaned up.
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreeRemove(c as string, a as string[]))).toBe(
      true,
    );
  });

  it('base-fails + branch-fails → fail with reason branch-failed', async () => {
    let vitestCalls = 0;
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true };
      if (isVitest(cmd, args)) {
        vitestCalls += 1;
        return vitestCalls === 1
          ? { ok: false, stdout: 'base red' }
          : { ok: false, stdout: 'branch still red' };
      }
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe('fail');
    if (result.kind === 'fail') {
      expect(result.reason).toBe('branch-failed');
      expect(result.evidence).toContain('branch still red');
    }
  });

  it('overlays every changed test file onto the base worktree', async () => {
    handler = (cmd, args) => {
      if (isVitest(cmd, args)) return { ok: false, stdout: 'base red' };
      return { ok: true };
    };

    await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts', 'packages/b/src/__tests__/y.ts'],
      signal: new AbortController().signal,
    });

    expect(copyFileSpy).toHaveBeenCalledTimes(2);
  });

  it('worktree removed even when the base run path throws (cleanup in finally)', async () => {
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) {
        // Simulate `git worktree add` failing → error propagates, finally still runs.
        return { ok: false, stderr: 'fatal: could not add worktree' };
      }
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      return { ok: true };
    };

    await expect(
      runFailThenPass({
        checkoutPath: CHECKOUT,
        baseRef: BASE_REF,
        changedTestFiles: ['packages/a/src/x.test.ts'],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    // finally block issued the removal despite the add failing.
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreeRemove(c as string, a as string[]))).toBe(
      true,
    );
  });
});
