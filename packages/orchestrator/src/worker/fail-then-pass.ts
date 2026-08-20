/**
 * Fail-then-pass regression proof (#1134 US3 / FR-011).
 *
 * Opt-in, off by default. When enabled for a `speckit-bugfix` run, this verifies
 * that the changed test files genuinely exercise the bug: they must FAIL on the
 * base ref (proving the test reproduces the defect) and PASS on the branch
 * (proving the fix resolves it). Either direction not holding is a finding.
 *
 * The base-ref run happens in a detached git worktree so the branch checkout and
 * its `node_modules` are never mutated (worktree isolation). The worktree is
 * always cleaned up in a `finally`, even on error.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface FailThenPassInput {
  /** The branch checkout root. */
  checkoutPath: string;
  /** Base ref to diff/checkout against, `origin/<base>`. */
  baseRef: string;
  /** Changed test files (diff set ∩ test globs), repo-relative. */
  changedTestFiles: string[];
  /** Abort signal for the spawned test runs. */
  signal: AbortSignal;
}

export type FailThenPassResult =
  | { kind: 'noop' }
  | { kind: 'pass' }
  | { kind: 'fail'; reason: 'base-passed' | 'branch-failed'; evidence: string };

interface TestRunOutcome {
  /** True iff the test run exited 0. */
  passed: boolean;
  /** Combined stdout+stderr tail for evidence. */
  output: string;
}

/**
 * Run the given test files with vitest in `cwd`. Never throws — a non-zero exit
 * (test failure) is captured as `{ passed: false }`.
 */
async function runTests(
  cwd: string,
  files: string[],
  signal: AbortSignal,
): Promise<TestRunOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync('pnpm', ['vitest', 'run', ...files], {
      cwd,
      signal,
    });
    return { passed: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || (e.message ?? String(err));
    return { passed: false, output };
  }
}

/**
 * Verify the changed test files fail on the base ref and pass on the branch.
 * Empty `changedTestFiles` is a non-blocking `noop`.
 */
export async function runFailThenPass(input: FailThenPassInput): Promise<FailThenPassResult> {
  const { checkoutPath, baseRef, changedTestFiles, signal } = input;

  if (changedTestFiles.length === 0) {
    return { kind: 'noop' };
  }

  const worktreePath = join(await mkdtemp(join(tmpdir(), 'gen-ftp-')), 'wt');

  let baseOutcome: TestRunOutcome;
  try {
    await execFileAsync('git', ['worktree', 'add', '--detach', worktreePath, baseRef], {
      cwd: checkoutPath,
      signal,
    });
    baseOutcome = await runTests(worktreePath, changedTestFiles, signal);
  } finally {
    // Always remove the worktree, even if the base run threw.
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: checkoutPath,
      signal,
    }).catch(() => {
      /* best-effort cleanup */
    });
  }

  if (baseOutcome.passed) {
    return {
      kind: 'fail',
      reason: 'base-passed',
      evidence:
        `The changed test file(s) PASSED on the base ref \`${baseRef}\`, so they do not ` +
        `reproduce the bug. Add a test that fails without the fix.\n\n${baseOutcome.output}`,
    };
  }

  const branchOutcome = await runTests(checkoutPath, changedTestFiles, signal);
  if (!branchOutcome.passed) {
    return {
      kind: 'fail',
      reason: 'branch-failed',
      evidence:
        `The changed test file(s) FAILED on the branch, so the fix does not make them ` +
        `pass.\n\n${branchOutcome.output}`,
    };
  }

  return { kind: 'pass' };
}
