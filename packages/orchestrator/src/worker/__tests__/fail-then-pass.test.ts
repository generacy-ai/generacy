import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #1134 T009 (US3 / SC-004)
//
// Exercises runFailThenPass by mocking node:child_process execFile. Each git /
// pnpm invocation is routed through a controllable handler so we can drive the
// base-ref run and the branch run independently and assert cleanup happens even
// on the error path — without real git worktrees or vitest subprocesses.
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

const { runFailThenPass } = await import('../fail-then-pass.js');

const BASE_REF = 'origin/develop';
const CHECKOUT = '/tmp/checkout';

function isWorktreeAdd(cmd: string, args: string[]): boolean {
  return cmd === 'git' && args[0] === 'worktree' && args[1] === 'add';
}
function isWorktreeRemove(cmd: string, args: string[]): boolean {
  return cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove';
}
function isVitest(cmd: string): boolean {
  return cmd === 'pnpm';
}

describe('runFailThenPass (#1134 T009)', () => {
  beforeEach(() => {
    execFileSpy.mockClear();
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

  it('base-fails + branch-passes → pass', async () => {
    let pnpmCalls = 0;
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isVitest(cmd)) {
        pnpmCalls += 1;
        // First pnpm run = base (fail), second = branch (pass).
        return pnpmCalls === 1 ? { ok: false, stdout: 'base red' } : { ok: true, stdout: 'branch green' };
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
    // worktree add + base run + worktree remove + branch run
    expect(pnpmCalls).toBe(2);
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreeRemove(c as string, a as string[]))).toBe(
      true,
    );
  });

  it('base-passes → fail with reason base-passed and evidence', async () => {
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isVitest(cmd)) return { ok: true, stdout: 'base unexpectedly green' };
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
    let pnpmCalls = 0;
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isVitest(cmd)) {
        pnpmCalls += 1;
        return pnpmCalls === 1
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
