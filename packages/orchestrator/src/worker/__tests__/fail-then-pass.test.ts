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
  /** Simulate a timeout kill (execFile sets `killed`/`code: 'ETIMEDOUT'`). */
  killed?: boolean;
  code?: string;
  /** Simulate an AbortError (execFile rejection when the signal aborts). */
  errName?: string;
}

// Routed synchronously by the mock; each test installs its own implementation.
let handler: (cmd: string, args: string[]) => ExecOutcome;
const execFileSpy = vi.fn((cmd: string, args: string[], _opts: unknown, cb: unknown) => {
  const callback = cb as (err: unknown, res?: { stdout: string; stderr: string }) => void;
  const r = handler(cmd, args);
  if (r.ok) {
    callback(null, { stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
  } else {
    const err = new Error('command failed') as Error & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      code?: string;
    };
    err.stdout = r.stdout ?? '';
    err.stderr = r.stderr ?? '';
    if (r.killed !== undefined) err.killed = r.killed;
    if (r.code !== undefined) err.code = r.code;
    if (r.errName !== undefined) err.name = r.errName;
    callback(err);
  }
});

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFileSpy as unknown as (...a: unknown[]) => void)(...args),
}));

// Stub the fs helpers so the overlay + temp-dir setup never touch the disk.
const mkdirSpy = vi.fn(async () => undefined);
const copyFileSpy = vi.fn(async () => undefined);
const rmSpy = vi.fn(async () => undefined);
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}XXXX`),
  mkdir: (...args: unknown[]) => (mkdirSpy as unknown as (...a: unknown[]) => Promise<void>)(...args),
  copyFile: (...args: unknown[]) =>
    (copyFileSpy as unknown as (...a: unknown[]) => Promise<void>)(...args),
  rm: (...args: unknown[]) => (rmSpy as unknown as (...a: unknown[]) => Promise<void>)(...args),
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
function isWorktreePrune(cmd: string, args: string[]): boolean {
  return cmd === 'git' && args[0] === 'worktree' && args[1] === 'prune';
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
    rmSpy.mockClear();
    // Restore the default no-op copy; tests that simulate a missing source
    // override this and must not leak the override into later tests.
    copyFileSpy.mockImplementation(async () => undefined);
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

  it('missing branch source (deleted/renamed test) is skipped non-blockingly', async () => {
    // The deleted path is in the base...HEAD diff but no longer exists in the
    // branch checkout, so copyFile from it throws ENOENT.
    copyFileSpy.mockImplementation(async (source: string) => {
      if (String(source).includes('gone.test.ts')) {
        const err = new Error('no such file') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return undefined;
    });

    let vitestCalls = 0;
    const vitestFileArgs: string[][] = [];
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true };
      if (isVitest(cmd, args)) {
        vitestCalls += 1;
        vitestFileArgs.push(args.slice(2)); // files after 'vitest', 'run'
        return vitestCalls === 1
          ? { ok: false, stdout: 'base red' }
          : { ok: true, stdout: 'branch green' };
      }
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/deleted/src/gone.test.ts', 'packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    // Infra condition did not hard-fail; the remaining test proves the fix.
    expect(result).toEqual({ kind: 'pass' });
    // Both files attempted; the missing one skipped, so only the present file
    // is exercised by both the base and branch runs.
    expect(copyFileSpy).toHaveBeenCalledTimes(2);
    expect(vitestFileArgs).toHaveLength(2);
    for (const files of vitestFileArgs) {
      expect(files).toEqual(['packages/a/src/x.test.ts']);
    }
    // worktree cleaned up.
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreeRemove(c as string, a as string[]))).toBe(
      true,
    );
  });

  it('all changed test files deleted/renamed on branch → noop, no vitest run', async () => {
    copyFileSpy.mockImplementation(async () => {
      const err = new Error('no such file') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true };
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts', 'packages/b/src/__tests__/y.ts'],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: 'noop' });
    // No test run happened, but the worktree was still cleaned up.
    expect(execFileSpy.mock.calls.some(([c, a]) => isVitest(c as string, a as string[]))).toBe(false);
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreeRemove(c as string, a as string[]))).toBe(
      true,
    );
  });

  it('non-ENOENT overlay error propagates (unexpected infra faults still fail loud)', async () => {
    copyFileSpy.mockImplementation(async () => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    handler = (cmd, args) => {
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

    // worktree cleaned up in finally despite the throw.
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreeRemove(c as string, a as string[]))).toBe(
      true,
    );
  });

  it('worktree-add failure → skip (not a hard failure), cleanup still runs (#1166 T006/FR-009)', async () => {
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) {
        // `git worktree add` fails → non-blocking skip, never a thrown/hard failure.
        return { ok: false, stderr: 'fatal: could not add worktree' };
      }
      if (isWorktreeRemove(cmd, args)) return { ok: true };
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
      expect(result.reason).toContain('worktree-add-failed');
    }
    // No vitest run happened; the finally still pruned + removed the mkdtemp parent.
    expect(execFileSpy.mock.calls.some(([c, a]) => isVitest(c as string, a as string[]))).toBe(false);
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreePrune(c as string, a as string[]))).toBe(
      true,
    );
    expect(rmSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // #1166 T013 (US3/US4) — infra-signature skips, timeout skips, AbortError
  // propagation, and mkdtemp-parent cleanup on every path.
  // -------------------------------------------------------------------------

  it('base run infra-fails (dist-resolution error, zero tests) → skip, never base-passed (SC-003)', async () => {
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true };
      if (isVitest(cmd, args)) {
        // Module resolution error before any test collected — an infra failure.
        return { ok: false, stderr: 'Error: Cannot find module @generacy-ai/foo/dist/index.js' };
      }
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
      expect(result.reason).toBe('infra:cannot-find-module at base ref');
    }
    // Only the base run happened — no branch run, and never a base-passed finding.
    expect(
      execFileSpy.mock.calls.filter(([c, a]) => isVitest(c as string, a as string[])),
    ).toHaveLength(1);
    // mkdtemp parent removed even on the infra-skip path.
    expect(rmSpy).toHaveBeenCalledTimes(1);
  });

  it('no-root-vitest branch run collects zero tests → skip, not a false branch-failed (FR-005/SC-003)', async () => {
    let vitestCalls = 0;
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true };
      if (isVitest(cmd, args)) {
        vitestCalls += 1;
        // base genuinely fails; branch collects zero tests (no root vitest).
        return vitestCalls === 1
          ? { ok: false, stdout: 'FAIL x.test.ts', stderr: '' }
          : { ok: false, stderr: 'No test files found, exiting with code 1' };
      }
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
      expect(result.reason).toBe('infra:no-test-files on branch');
    }
    expect(vitestCalls).toBe(2);
  });

  it('a collected-and-failed base test is NOT masked as infra → genuine base-passed/branch-failed path', async () => {
    let vitestCalls = 0;
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true };
      if (isVitest(cmd, args)) {
        vitestCalls += 1;
        // base FAILs a collected test (genuine), branch passes → overall pass.
        return vitestCalls === 1
          ? { ok: false, stdout: 'FAIL  x.test.ts > reproduces bug\n Tests  1 failed' }
          : { ok: true, stdout: 'PASS  x.test.ts\n Tests  1 passed' };
      }
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    // The collected FAIL is a genuine base failure, not infra — proof proceeds and passes.
    expect(result).toEqual({ kind: 'pass' });
  });

  it('base run hits BASE_TEST_TIMEOUT_MS → skip: timeout (SC-004)', async () => {
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true };
      if (isVitest(cmd, args)) {
        // execFile timeout kill: killed=true, code=ETIMEDOUT.
        return { ok: false, killed: true, code: 'ETIMEDOUT', stderr: 'killed' };
      }
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: 'skip', reason: 'timeout' });
    // mkdtemp parent still removed on the timeout path.
    expect(rmSpy).toHaveBeenCalledTimes(1);
  });

  it('AbortError from the phase signal propagates — NOT converted to a spurious finding (SC-004)', async () => {
    const ac = new AbortController();
    ac.abort();
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true };
      if (isVitest(cmd, args)) {
        // Rejection that coincides with an aborted signal → must rethrow.
        return { ok: false, errName: 'AbortError', stderr: 'aborted' };
      }
      return { ok: true };
    };

    await expect(
      runFailThenPass({
        checkoutPath: CHECKOUT,
        baseRef: BASE_REF,
        changedTestFiles: ['packages/a/src/x.test.ts'],
        signal: ac.signal,
      }),
    ).rejects.toThrow();

    // Cleanup still ran despite the propagated abort (signal-free prune + parent rm).
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreePrune(c as string, a as string[]))).toBe(
      true,
    );
    expect(rmSpy).toHaveBeenCalledTimes(1);
  });

  it('mkdtemp parent + prune cleanup run on the happy (pass) path too (SC-005)', async () => {
    let vitestCalls = 0;
    handler = (cmd, args) => {
      if (isWorktreeAdd(cmd, args)) return { ok: true };
      if (isWorktreeRemove(cmd, args)) return { ok: true };
      if (isPnpmInstall(cmd, args)) return { ok: true };
      if (isVitest(cmd, args)) {
        vitestCalls += 1;
        return vitestCalls === 1 ? { ok: false, stdout: 'base red' } : { ok: true, stdout: 'green' };
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
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreeRemove(c as string, a as string[]))).toBe(
      true,
    );
    expect(execFileSpy.mock.calls.some(([c, a]) => isWorktreePrune(c as string, a as string[]))).toBe(
      true,
    );
    expect(rmSpy).toHaveBeenCalledTimes(1);
  });
});
