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
  /** execFile sets `code` to the numeric exit code, or a string such as ETIMEDOUT. */
  code?: string | number;
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
      code?: string | number;
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
// `stat` backs the no-root-vitest fallback's nearest-`package.json` walk. Tests
// that exercise the fallback list the package.json paths that "exist".
let existingPackageJsons: Set<string> = new Set();
const statSpy = vi.fn(async (path: string) => {
  if (existingPackageJsons.has(path)) return {};
  const err = new Error('no such file') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
});
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}XXXX`),
  mkdir: (...args: unknown[]) =>
    (mkdirSpy as unknown as (...a: unknown[]) => Promise<void>)(...args),
  copyFile: (...args: unknown[]) =>
    (copyFileSpy as unknown as (...a: unknown[]) => Promise<void>)(...args),
  rm: (...args: unknown[]) => (rmSpy as unknown as (...a: unknown[]) => Promise<void>)(...args),
  stat: (...args: unknown[]) =>
    (statSpy as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));

const { runFailThenPass, isInfraFailure, isRunnerNotFound } = await import('../fail-then-pass.js');

// ---------------------------------------------------------------------------
// Realistic runner-output fixtures. Captured verbatim from `npx vitest run`
// (vitest 3.2.4 / vite 7.3.1 / node 22) and `pnpm vitest run` (pnpm 9.15.9) in
// a scratch workspace on 2026-08-22; only the absolute scratch path was
// shortened to `/work/repo` and a vite internals path to `<vite>`. The
// `broken.test.ts` fixture is a test importing a nonexistent `../dist/…` —
// the shape every dist-resolving monorepo (generacy included) produces when
// the base worktree has not been built.
// ---------------------------------------------------------------------------

/** Suite failed to LOAD (dist-resolution) — zero tests collected. Exit 1. */
const VITEST_SUITE_LOAD_FAILURE = `
 RUN  v3.2.4 /work/repo


⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  broken.test.ts [ broken.test.ts ]
Error: Cannot find module '../dist/nonexistent.js' imported from '/work/repo/broken.test.ts'
 ❯ broken.test.ts:2:1
      1| import { describe, it, expect } from 'vitest';
      2| import { thing } from '../dist/nonexistent.js';
       | ^
      3| describe('broken', () => { it('x', () => { expect(thing).toBe(1); }); …
      4| 

Caused by: Error: Failed to load url ../dist/nonexistent.js (resolved id: ../dist/nonexistent.js) in /work/repo/broken.test.ts. Does the file exist?
 ❯ loadAndTransform <vite>/dist/node/chunks/config.js:22663:33

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  no tests
   Start at  04:10:44
   Duration  559ms (transform 77ms, setup 0ms, collect 0ms, tests 0ms, environment 1ms, prepare 116ms)
`;

/** A collected test genuinely failed (assertion). Exit 1. */
const VITEST_GENUINE_FAILURE = `
 RUN  v3.2.4 /work/repo

 ❯ real-fail.test.ts (2 tests | 1 failed) 10ms
   × real > fails 8ms
     → expected 1 to be 2 // Object.is equality
   ✓ real > passes 0ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  real-fail.test.ts > real > fails
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1

 ❯ real-fail.test.ts:2:56
      1| import { describe, it, expect } from 'vitest';
      2| describe('real', () => { it('fails', () => { expect(1).toBe(2); }); it…
       |                                                        ^
      3| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  04:10:45
   Duration  467ms (transform 47ms, setup 0ms, collect 36ms, tests 10ms, environment 0ms, prepare 89ms)
`;

/** One suite failed to load AND one collected test genuinely failed. Exit 1. */
const VITEST_MIXED_FAILURE = `
 RUN  v3.2.4 /work/repo

 ❯ real-fail.test.ts (2 tests | 1 failed) 10ms
   × real > fails 8ms
     → expected 1 to be 2 // Object.is equality
   ✓ real > passes 0ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  broken.test.ts [ broken.test.ts ]
Error: Cannot find module '../dist/nonexistent.js' imported from '/work/repo/broken.test.ts'
 ❯ broken.test.ts:2:1

Caused by: Error: Failed to load url ../dist/nonexistent.js (resolved id: ../dist/nonexistent.js) in /work/repo/broken.test.ts. Does the file exist?
 ❯ loadAndTransform <vite>/dist/node/chunks/config.js:22663:33

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯


⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  real-fail.test.ts > real > fails
AssertionError: expected 1 to be 2 // Object.is equality

 ❯ real-fail.test.ts:2:56

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  2 failed (2)
      Tests  1 failed | 1 passed (2)
   Start at  04:10:47
   Duration  472ms (transform 66ms, setup 0ms, collect 27ms, tests 10ms, environment 0ms, prepare 190ms)
`;

/** vitest resolved no files for the filter. Exit 1. */
const VITEST_NO_TEST_FILES = `
 RUN  v3.2.4 /work/repo

No test files found, exiting with code 1

filter: nope.test.ts
include: **/*.{test,spec}.?(c|m)[jt]s?(x)
exclude:  **/node_modules/**, **/dist/**, **/cypress/**, **/.{idea,git,cache,output,temp}/**, **/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*
`;

/** All tests passed. Exit 0. */
const VITEST_PASS = `
 RUN  v3.2.4 /work/repo

 ✓ pass.test.ts (1 test) 2ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  04:10:48
   Duration  443ms (transform 44ms, setup 0ms, collect 34ms, tests 2ms, environment 0ms, prepare 74ms)
`;

/**
 * Root `pnpm vitest run` in a workspace where vitest is only a package
 * devDependency (pnpm 9.15.9). Exit 254. `undefined` is pnpm's own stray line.
 */
const PNPM_VITEST_NOT_FOUND = `undefined
 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "vitest" not found`;
const PNPM_VITEST_NOT_FOUND_EXIT = 254;

/**
 * `pnpm --filter <pkg> exec vitest run` wrapping a GENUINE failure (pnpm
 * 9.15.9): the same ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL code, exit 1. This is why
 * that code alone must not be a not-found signature.
 */
const PNPM_FILTER_EXEC_GENUINE_FAILURE = `
 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  04:11:51
   Duration  469ms (transform 67ms, setup 0ms, collect 54ms, tests 9ms, environment 0ms, prepare 115ms)

undefined
/work/repo/packages/a:
 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed with exit code 1: vitest run x.test.ts`;

describe('isInfraFailure / isRunnerNotFound classification (realistic vitest 3.2.4 + pnpm 9.15 output)', () => {
  it('suite-level load failure (Cannot find module + FAIL [file] + "Tests no tests") → infra, despite "Test Files 1 failed"', () => {
    expect(/Test Files\s+1 failed/.test(VITEST_SUITE_LOAD_FAILURE)).toBe(true);
    expect(/\bFAIL\b/.test(VITEST_SUITE_LOAD_FAILURE)).toBe(true);
    expect(isInfraFailure(VITEST_SUITE_LOAD_FAILURE, 1)).toBe(true);
  });

  it('genuine assertion failure (× line, FAIL file > name, "Tests 1 failed") → NOT infra', () => {
    expect(isInfraFailure(VITEST_GENUINE_FAILURE, 1)).toBe(false);
  });

  it('broken suite + a genuine test failure in the same run → NOT infra (a real failure is never masked)', () => {
    expect(isInfraFailure(VITEST_MIXED_FAILURE, 1)).toBe(false);
  });

  it('"No test files found" → infra', () => {
    expect(isInfraFailure(VITEST_NO_TEST_FILES, 1)).toBe(true);
  });

  it('all-pass output → NOT infra', () => {
    expect(isInfraFailure(VITEST_PASS)).toBe(false);
    expect(isInfraFailure(VITEST_PASS, 0)).toBe(false);
  });

  it('pnpm `Command "vitest" not found` (exit 254) → infra / runner-not-found', () => {
    expect(isRunnerNotFound(PNPM_VITEST_NOT_FOUND, PNPM_VITEST_NOT_FOUND_EXIT)).toBe(true);
    expect(isInfraFailure(PNPM_VITEST_NOT_FOUND, PNPM_VITEST_NOT_FOUND_EXIT)).toBe(true);
    // The text alone is enough (no exit code available).
    expect(isInfraFailure(PNPM_VITEST_NOT_FOUND)).toBe(true);
  });

  it('exit 127 / "command not found" (no pnpm at all) → infra / runner-not-found', () => {
    expect(isRunnerNotFound('/bin/sh: 1: pnpm: command not found', 127)).toBe(true);
    expect(isRunnerNotFound('', 127)).toBe(true);
    expect(isRunnerNotFound('', 254)).toBe(true);
  });

  it('pnpm "No projects matched the filters" (exit 0 no-op) → infra / runner-not-found', () => {
    expect(isRunnerNotFound('No projects matched the filters in "/work/repo"', 0)).toBe(true);
    expect(isInfraFailure('No projects matched the filters in "/work/repo"', 0)).toBe(true);
  });

  it('ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL wrapping a genuine failure → NOT infra', () => {
    expect(isRunnerNotFound(PNPM_FILTER_EXEC_GENUINE_FAILURE, 1)).toBe(false);
    expect(isInfraFailure(PNPM_FILTER_EXEC_GENUINE_FAILURE, 1)).toBe(false);
  });

  it('bare module-resolution error with no run evidence → infra (legacy fixture)', () => {
    expect(isInfraFailure('Error: Cannot find module @generacy-ai/foo/dist/index.js')).toBe(true);
    expect(isInfraFailure('Error [ERR_MODULE_NOT_FOUND]: Cannot find package')).toBe(true);
  });

  it('ambiguous non-zero output with no signature → NOT infra (bias to a genuine outcome)', () => {
    expect(isInfraFailure('base red', 1)).toBe(false);
    expect(isInfraFailure('FAIL x.test.ts', 1)).toBe(false);
    expect(isInfraFailure('', 1)).toBe(false);
  });
});

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
    statSpy.mockClear();
    existingPackageJsons = new Set();
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
        // Real vitest 3 output for a suite that failed to LOAD (unbuilt dist):
        // prints ` FAIL  file [ file ]` AND `Test Files  1 failed` yet collected
        // zero tests — must be infra, never a satisfied fail-on-base.
        return { ok: false, stdout: VITEST_SUITE_LOAD_FAILURE, code: 1 };
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

  // -------------------------------------------------------------------------
  // Defect 1 — suite-level dist-resolution failures in a dist-resolving
  // monorepo were read as genuine base failures; defect 2 — no-root-vitest
  // repos produced a false `branch-failed`. Realistic fixtures throughout.
  // -------------------------------------------------------------------------

  it('suite-load failure at base + genuine pass on branch → skip (the base never exercised a test)', async () => {
    let vitestCalls = 0;
    handler = (cmd, args) => {
      if (isVitest(cmd, args)) {
        vitestCalls += 1;
        return vitestCalls === 1
          ? { ok: false, stdout: VITEST_SUITE_LOAD_FAILURE, code: 1 }
          : { ok: true, stdout: VITEST_PASS };
      }
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    // Previously this degenerated to "does the branch pass" → `pass`.
    expect(result).toEqual({
      kind: 'skip',
      reason: 'infra:cannot-find-module at base ref',
    });
    expect(vitestCalls).toBe(1);
  });

  it('genuine assertion failure at base (realistic output) + pass on branch → pass', async () => {
    let vitestCalls = 0;
    handler = (cmd, args) => {
      if (isVitest(cmd, args)) {
        vitestCalls += 1;
        return vitestCalls === 1
          ? { ok: false, stdout: VITEST_GENUINE_FAILURE, code: 1 }
          : { ok: true, stdout: VITEST_PASS };
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
    expect(vitestCalls).toBe(2);
  });

  it('mixed (broken suite + genuine failure) at base, suite-load failure on branch → branch skip, not pass', async () => {
    let vitestCalls = 0;
    handler = (cmd, args) => {
      if (isVitest(cmd, args)) {
        vitestCalls += 1;
        return vitestCalls === 1
          ? { ok: false, stdout: VITEST_MIXED_FAILURE, code: 1 }
          : { ok: false, stdout: VITEST_SUITE_LOAD_FAILURE, code: 1 };
      }
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      kind: 'skip',
      reason: 'infra:cannot-find-module on branch',
    });
  });

  it('base exits 0 but collected zero tests ("No test files found" / passWithNoTests) → skip, never base-passed', async () => {
    handler = (cmd, args) => {
      if (isVitest(cmd, args)) return { ok: true, stdout: VITEST_NO_TEST_FILES };
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      kind: 'skip',
      reason: 'infra:no-test-files at base ref',
    });
  });

  it('no root vitest anywhere (root + branch both `Command "vitest" not found`, no owning package) → skip vitest-not-found, NOT branch-failed', async () => {
    // No package.json is reachable for the changed file, so no fallback run.
    let vitestCalls = 0;
    handler = (cmd, args) => {
      if (isVitest(cmd, args)) {
        vitestCalls += 1;
        return {
          ok: false,
          stderr: PNPM_VITEST_NOT_FOUND,
          code: PNPM_VITEST_NOT_FOUND_EXIT,
        };
      }
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    // Previously: base "fails", branch "fails" → { kind: 'fail', reason: 'branch-failed' }.
    expect(result).toEqual({
      kind: 'skip',
      reason: 'infra:vitest-not-found at base ref',
    });
    // Short-circuited at the base side: only the base root run happened.
    expect(vitestCalls).toBe(1);
    expect(execFileSpy.mock.calls.some(([, a]) => (a as string[])[0] === '--dir')).toBe(false);
  });

  it('no root vitest → falls back to `pnpm --dir <owning pkg> exec vitest run <pkg-relative files>` on both refs', async () => {
    const worktree = '/tmp/gen-ftp-XXXX/wt';
    existingPackageJsons = new Set([
      `${worktree}/packages/a/package.json`,
      `${CHECKOUT}/packages/a/package.json`,
      `${worktree}/packages/b/package.json`,
      `${CHECKOUT}/packages/b/package.json`,
    ]);
    const spawns: Array<{ args: string[]; cwd: string }> = [];
    let dirCalls = 0;
    handler = (cmd, args) => {
      if (isVitest(cmd, args)) {
        return {
          ok: false,
          stderr: PNPM_VITEST_NOT_FOUND,
          code: PNPM_VITEST_NOT_FOUND_EXIT,
        };
      }
      if (cmd === 'pnpm' && args[0] === '--dir') {
        dirCalls += 1;
        // base: both packages fail genuinely; branch: both pass.
        return dirCalls <= 2
          ? { ok: false, stdout: VITEST_GENUINE_FAILURE, code: 1 }
          : { ok: true, stdout: VITEST_PASS };
      }
      return { ok: true };
    };
    execFileSpy.mockImplementation((cmd: string, args: string[], opts: unknown, cb: unknown) => {
      if (cmd === 'pnpm') spawns.push({ args, cwd: (opts as { cwd: string }).cwd });
      const callback = cb as (err: unknown, res?: { stdout: string; stderr: string }) => void;
      const r = handler(cmd, args);
      if (r.ok) {
        callback(null, { stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
      } else {
        const err = new Error('command failed') as Error & {
          stdout?: string;
          stderr?: string;
          code?: string | number;
        };
        err.stdout = r.stdout ?? '';
        err.stderr = r.stderr ?? '';
        err.code = r.code;
        callback(err);
      }
    });

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: [
        'packages/a/src/x.test.ts',
        'packages/a/src/__tests__/y.test.ts',
        'packages/b/test/z.test.ts',
      ],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: 'pass' });
    const fallback = spawns.filter((s) => s.args[0] === '--dir');
    expect(fallback.map((s) => s.args)).toEqual([
      ['--dir', 'packages/a', 'exec', 'vitest', 'run', 'src/x.test.ts', 'src/__tests__/y.test.ts'],
      ['--dir', 'packages/b', 'exec', 'vitest', 'run', 'test/z.test.ts'],
      ['--dir', 'packages/a', 'exec', 'vitest', 'run', 'src/x.test.ts', 'src/__tests__/y.test.ts'],
      ['--dir', 'packages/b', 'exec', 'vitest', 'run', 'test/z.test.ts'],
    ]);
    // Fallback runs are spawned from the same root as the failed root run
    // (base worktree first, then the branch checkout).
    expect(fallback.map((s) => s.cwd)).toEqual([worktree, worktree, CHECKOUT, CHECKOUT]);
    // `--filter` is never used (exit-0 "No projects matched" trap).
    expect(spawns.some((s) => s.args.includes('--filter'))).toBe(false);
  });

  it('no root vitest and the owning package has no vitest either → skip vitest-not-found', async () => {
    const worktree = '/tmp/gen-ftp-XXXX/wt';
    existingPackageJsons = new Set([`${worktree}/packages/a/package.json`]);
    handler = (cmd, args) => {
      if (isVitest(cmd, args) || (cmd === 'pnpm' && args[0] === '--dir')) {
        return {
          ok: false,
          stderr: PNPM_VITEST_NOT_FOUND,
          code: PNPM_VITEST_NOT_FOUND_EXIT,
        };
      }
      return { ok: true };
    };

    const result = await runFailThenPass({
      checkoutPath: CHECKOUT,
      baseRef: BASE_REF,
      changedTestFiles: ['packages/a/src/x.test.ts'],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      kind: 'skip',
      reason: 'infra:vitest-not-found at base ref',
    });
  });

  it('fallback genuine failure on the branch (ERR_PNPM wrapper, exit 1) is still branch-failed, not infra', async () => {
    const worktree = '/tmp/gen-ftp-XXXX/wt';
    existingPackageJsons = new Set([
      `${worktree}/packages/a/package.json`,
      `${CHECKOUT}/packages/a/package.json`,
    ]);
    handler = (cmd, args) => {
      if (isVitest(cmd, args)) {
        return {
          ok: false,
          stderr: PNPM_VITEST_NOT_FOUND,
          code: PNPM_VITEST_NOT_FOUND_EXIT,
        };
      }
      if (cmd === 'pnpm' && args[0] === '--dir') {
        return { ok: false, stdout: PNPM_FILTER_EXEC_GENUINE_FAILURE, code: 1 };
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
      expect(result.evidence).toContain('pnpm --dir packages/a exec vitest run src/x.test.ts');
    }
  });
});
