/**
 * Fail-then-pass regression proof (#1134 US3 / FR-011).
 *
 * Opt-in, off by default. When enabled for a `speckit-bugfix` run, this verifies
 * that the changed test files genuinely exercise the bug: they must FAIL on the
 * base ref (proving the test reproduces the defect) and PASS on the branch
 * (proving the fix resolves it). Either direction not holding is a finding.
 *
 * The base-ref run happens in a detached git worktree so the branch checkout and
 * its `node_modules` are never mutated (worktree isolation). Because a worktree is
 * a bare source checkout with no `node_modules` (gitignored, never part of a
 * worktree), two setup steps make the base run non-vacuous:
 *   1. Dependencies are installed against the BASE lockfile so `pnpm vitest run`
 *      can actually execute. Without this the base run always exits non-zero for
 *      infrastructure reasons and the whole proof degenerates to "does the branch
 *      pass" (see #1150 review).
 *   2. The branch's version of each changed test file is overlaid onto the base
 *      checkout. A new test is absent at the base ref, and a modified test carries
 *      its OLD assertions there — either way the base SOURCE must be exercised by
 *      the BRANCH's test to prove it reproduces the bug (new test + old code =
 *      fail). This is the explicit handling of the "test file absent at base" case.
 *
 * The worktree is always cleaned up in a `finally`, even on error.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Wall-clock backstop for the base-ref `pnpm install`. The branch already
 * installed, so the pnpm store is warm and this is mostly hardlink/symlink work;
 * the timeout only guards against a cold store having to hit the network.
 */
const BASE_INSTALL_TIMEOUT_MS = 5 * 60_000;

/**
 * Wall-clock cap for a single base/branch `pnpm vitest run` (FR-006). Mirrors
 * BASE_INSTALL_TIMEOUT_MS; applied per-run, independent of the install cap. Sits
 * under the cli-spawner phase cap so a hung test run aborts inside fail-then-pass
 * (as a non-blocking skip) rather than stalling the outer phase spawn.
 */
const BASE_TEST_TIMEOUT_MS = 5 * 60_000;

/**
 * Conservative infra-failure signature (FR-004, FR-005; Q2=A pre-collection only).
 *
 * Returns `true` ONLY when the test run failed for an infrastructure reason
 * *before any test was collected/run* — vitest resolved zero test files, or a
 * module/dist-resolution error surfaced before a test executed. Such a run is a
 * broken base/branch env, not evidence about the bug, so the caller maps it to a
 * non-blocking `skip` rather than a `base-passed`/`branch-failed` finding.
 *
 * Returns `false` for any output showing a test was collected and then failed
 * (`FAIL`, per-test `×`/`✓` lines, `Tests  N failed`/`N passed`) and for anything
 * ambiguous — bias to a genuine outcome so a real failure is never masked.
 */
export function isInfraFailure(output: string): boolean {
  // A collected-and-run test is a genuine outcome — never infra.
  const ranTests =
    /\bFAIL\b/.test(output) ||
    /\bPASS\b/.test(output) ||
    /Tests\s+\d+\s+(failed|passed)/.test(output) ||
    /Test Files\s+\d+\s+(failed|passed)/.test(output) ||
    /[×✓]\s/.test(output);
  if (ranTests) {
    return false;
  }

  // Pre-collection signatures: vitest found nothing to run, or a module/dist
  // resolution error surfaced before any test executed.
  return (
    /No test files found/.test(output) ||
    /Cannot find module/.test(output) ||
    /Failed to resolve import/.test(output) ||
    /Failed to load url/.test(output) ||
    /ERR_MODULE_NOT_FOUND/.test(output)
  );
}

/**
 * Short, log-safe discriminator for the matched infra signature. Assumes
 * `isInfraFailure(output)` already returned `true`; returns `unknown` otherwise.
 */
function infraSignature(output: string): string {
  if (/No test files found/.test(output)) return 'no-test-files';
  if (/Cannot find module/.test(output)) return 'cannot-find-module';
  if (/Failed to resolve import/.test(output)) return 'failed-to-resolve-import';
  if (/Failed to load url/.test(output)) return 'failed-to-load-url';
  if (/ERR_MODULE_NOT_FOUND/.test(output)) return 'err-module-not-found';
  return 'unknown';
}

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
  | { kind: 'skip'; reason: string }
  | { kind: 'pass' }
  | { kind: 'fail'; reason: 'base-passed' | 'branch-failed'; evidence: string };

interface TestRunOutcome {
  /** True iff the test run exited 0. */
  passed: boolean;
  /** Combined stdout+stderr tail for evidence. */
  output: string;
  /** FR-006: true iff the run was killed by BASE_TEST_TIMEOUT_MS (not an abort). */
  timedOut: boolean;
}

/**
 * Run the given test files with vitest in `cwd`. Never throws — a non-zero exit
 * (test failure) is captured as `{ passed: false }`. A run that overruns
 * BASE_TEST_TIMEOUT_MS is killed and reported as `{ timedOut: true }` (FR-006);
 * an `AbortError` from the caller's phase `signal` propagates (must not be
 * converted into a spurious finding).
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
      timeout: BASE_TEST_TIMEOUT_MS,
    });
    return { passed: true, output: `${stdout}\n${stderr}`.trim(), timedOut: false };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
      code?: string;
      name?: string;
    };
    // An AbortError from the phase signal must propagate — it means the whole
    // phase was cancelled, not that the tests produced a verdict.
    if (e.name === 'AbortError' || signal.aborted) {
      throw err;
    }
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || (e.message ?? String(err));
    const timedOut = e.killed === true || e.code === 'ETIMEDOUT';
    return { passed: false, output, timedOut };
  }
}

/**
 * Install dependencies in the base worktree against the base lockfile. Uses the
 * warm pnpm store from the branch install (`--prefer-offline`) and pins to the
 * committed base lockfile (`--frozen-lockfile`) for a deterministic base env.
 * Never throws — a failed install is reported so the caller can skip the proof
 * (non-blocking) rather than mistake an install failure for a base test failure.
 */
async function installDeps(
  cwd: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'pnpm',
      ['install', '--frozen-lockfile', '--prefer-offline'],
      { cwd, signal, timeout: BASE_INSTALL_TIMEOUT_MS },
    );
    return { ok: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || (e.message ?? String(err));
    return { ok: false, output };
  }
}

/**
 * Overlay the branch's version of each changed test file onto the base worktree,
 * creating parent directories as needed. This is what makes a newly-added test
 * file (absent at the base ref) runnable against the base source.
 *
 * A path in the base...HEAD diff may have been DELETED or RENAMED on the branch,
 * so it no longer exists in the branch checkout. Copying such a phantom source
 * throws `ENOENT`; that is an infrastructure condition, not a proof failure, and
 * must not hard-fail validate (mirrors the non-blocking install-failure skip). A
 * missing source is simply not overlaid, and — since a test file absent on the
 * branch has no branch version to prove — it is dropped from the effective proof
 * set. Returns the files that were actually overlaid.
 */
async function overlayTestFiles(
  fromRoot: string,
  toRoot: string,
  files: string[],
): Promise<string[]> {
  const overlaid: string[] = [];
  for (const file of files) {
    const dest = join(toRoot, file);
    try {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(fromRoot, file), dest);
      overlaid.push(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Deleted/renamed-away on the branch: no branch source to overlay or
        // prove — skip it non-blockingly rather than throwing into validate.
        continue;
      }
      throw err;
    }
  }
  return overlaid;
}

/**
 * Verify the changed test files fail on the base ref and pass on the branch.
 * Empty `changedTestFiles` is a non-blocking `noop`. A base env that cannot be
 * prepared (dependency install fails) is a non-blocking `skip` — it is never
 * reported as a base test failure.
 */
export async function runFailThenPass(input: FailThenPassInput): Promise<FailThenPassResult> {
  const { checkoutPath, baseRef, changedTestFiles, signal } = input;

  if (changedTestFiles.length === 0) {
    return { kind: 'noop' };
  }

  // Capture the mkdtemp parent so it (not just the inner `wt` worktree) is
  // removed on every exit path (FR-007).
  const tmpParent = await mkdtemp(join(tmpdir(), 'gen-ftp-'));
  const worktreePath = join(tmpParent, 'wt');

  let baseOutcome: TestRunOutcome;
  let effectiveTestFiles: string[];
  try {
    try {
      await execFileAsync('git', ['worktree', 'add', '--detach', worktreePath, baseRef], {
        cwd: checkoutPath,
        signal,
      });
    } catch (err) {
      // A worktree-add failure is an infrastructure condition, not a proof
      // failure — skip rather than hard-fail validate (FR-009). The `finally`
      // still runs (prune + parent cleanup handle a partially-created worktree).
      const e = err as { message?: string };
      return { kind: 'skip', reason: `worktree-add-failed: ${e.message ?? String(err)}` };
    }

    const install = await installDeps(worktreePath, signal);
    if (!install.ok) {
      return {
        kind: 'skip',
        reason:
          `fail-then-pass skipped: could not install dependencies at the base ref ` +
          `\`${baseRef}\`, so the regression proof could not run.\n\n${install.output}`,
      };
    }

    // Only files that still exist on the branch can be overlaid AND run there;
    // deleted/renamed-away paths drop out of the proof set entirely.
    effectiveTestFiles = await overlayTestFiles(checkoutPath, worktreePath, changedTestFiles);
    if (effectiveTestFiles.length === 0) {
      // Every changed test path was deleted/renamed on the branch — no branch
      // test remains to prove anything. Non-blocking, same as an empty input.
      return { kind: 'noop' };
    }
    baseOutcome = await runTests(worktreePath, effectiveTestFiles, signal);
  } finally {
    // Always clean up, even if the base setup/run threw. Each step is
    // best-effort and runs WITHOUT the abort signal (FR-008): if the phase was
    // aborted the signal is already aborted, and passing it would reject the
    // cleanup exec immediately and orphan the worktree registration. Guarded so
    // one failure does not skip the next.
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: checkoutPath,
    }).catch(() => {
      /* best-effort cleanup */
    });
    await execFileAsync('git', ['worktree', 'prune'], { cwd: checkoutPath }).catch(() => {
      /* reconcile an orphaned registration (FR-008) */
    });
    await rm(tmpParent, { recursive: true, force: true }).catch(() => {
      /* remove the mkdtemp parent (FR-007) */
    });
  }

  // A base run that timed out or infra-failed is a broken base env, never a
  // verdict about the bug — skip rather than report `base-passed` (FR-004/006).
  if (!baseOutcome.passed && baseOutcome.timedOut) {
    return { kind: 'skip', reason: 'timeout' };
  }
  if (!baseOutcome.passed && isInfraFailure(baseOutcome.output)) {
    return { kind: 'skip', reason: `infra:${infraSignature(baseOutcome.output)} at base ref` };
  }

  if (baseOutcome.passed) {
    return {
      kind: 'fail',
      reason: 'base-passed',
      evidence:
        `The changed test file(s) PASSED against the base ref \`${baseRef}\` source, so ` +
        `they do not reproduce the bug. Add a test that fails without the fix.\n\n${baseOutcome.output}`,
    };
  }

  const branchOutcome = await runTests(checkoutPath, effectiveTestFiles, signal);
  // A branch run that timed out or infra-failed (e.g. no root vitest → zero
  // tests collected, FR-005) is a broken branch env, never a `branch-failed`
  // verdict — skip.
  if (!branchOutcome.passed && branchOutcome.timedOut) {
    return { kind: 'skip', reason: 'timeout' };
  }
  if (!branchOutcome.passed && isInfraFailure(branchOutcome.output)) {
    return { kind: 'skip', reason: `infra:${infraSignature(branchOutcome.output)} on branch` };
  }
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
