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
import { mkdtemp, mkdir, copyFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';

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
 * Exit codes that mean the runner itself never started: 127 is the shell's
 * "command not found"; 254 is pnpm's `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` for
 * `Command "vitest" not found` (verified against pnpm 9.15 — a root
 * `pnpm vitest run` in a workspace where vitest is only a package devDependency).
 */
const RUNNER_NOT_FOUND_EXIT_CODES = new Set([127, 254]);

/**
 * The runner (vitest / pnpm) never started (FR-005).
 *
 * `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` on its own is deliberately NOT a
 * signature: `pnpm --filter <pkg> exec vitest run` prints that same code for a
 * genuine test failure (`Command failed with exit code 1: vitest run …`). Only
 * the `Command "vitest" not found` form means the runner was absent.
 * `No projects matched the filters` is pnpm's exit-0 no-op for an unknown
 * `--filter` target — a silent false pass, so it is infra too.
 */
export function isRunnerNotFound(output: string, exitCode?: number): boolean {
  return (
    /Command "vitest" not found/.test(output) ||
    /\bvitest: (command )?not found\b/.test(output) ||
    // Shell-level not-found must name the runner on the same line — a bare
    // "command not found" can appear inside a genuine test's assertion diff.
    /^[^\n]*\bvitest\b[^\n]*\bcommand not found\b/m.test(output) ||
    /No projects matched the filters/.test(output) ||
    (exitCode !== undefined && RUNNER_NOT_FOUND_EXIT_CODES.has(exitCode))
  );
}

/** vitest started but collected zero tests (nothing was exercised). */
function isZeroTestsCollected(output: string): boolean {
  return /No test files found/.test(output) || /Tests\s+no tests\b/.test(output);
}

/** A module / dist-resolution (load) error surfaced somewhere in the output. */
function hasModuleResolutionError(output: string): boolean {
  return (
    /Cannot find module/.test(output) ||
    /Failed to resolve import/.test(output) ||
    /Failed to load url/.test(output) ||
    /ERR_MODULE_NOT_FOUND/.test(output)
  );
}

/**
 * At least one COLLECTED test failed — the only thing that makes a non-zero exit
 * a genuine verdict about the bug. vitest 3 prints a per-test `×` line, a
 * per-test ` FAIL  <file> > <name>` block, and a `Tests  N failed` summary; a
 * suite that failed to load prints none of these (it prints `Tests  no tests`).
 */
function hasTestLevelFailure(output: string): boolean {
  return (
    /^\s*[×✗]\s/m.test(output) ||
    /Tests\s+\d+\s+failed/.test(output) ||
    /\bFAIL\s+\S+\s+>\s/.test(output)
  );
}

/**
 * vitest's suite-level (collection) failure line, ` FAIL  <file> [ <file> ]`,
 * as opposed to the per-test ` FAIL  <file> > <test name>` line. A workspace
 * project prefix (` FAIL  |proj| file [ file ]`) is tolerated.
 */
function hasSuiteLevelFailure(output: string): boolean {
  return /\bFAIL\s+.*\[\s*[^\]\s]+\s*\]/.test(output);
}

/** Any evidence that a test actually ran (passing or failing). */
function hasRunEvidence(output: string): boolean {
  return (
    /\bFAIL\b/.test(output) ||
    /\bPASS\b/.test(output) ||
    /Tests\s+\d+\s+(failed|passed)/.test(output) ||
    /Test Files\s+\d+\s+(failed|passed)/.test(output) ||
    /[×✓✗]\s/.test(output)
  );
}

/**
 * Infra-failure classifier (FR-004, FR-005; Q2=A pre-collection only).
 *
 * Returns `true` ONLY when the run is not evidence about the bug because no
 * test was actually exercised. Rules, in order:
 *
 *   1. The runner never started (`Command "vitest" not found`, `command not
 *      found`, exit 127/254, `No projects matched the filters`) → infra.
 *   2. vitest collected zero tests (`No test files found`, `Tests  no tests`)
 *      → infra. This fires regardless of the `Test Files  N failed` summary,
 *      which vitest also prints for a suite that failed to LOAD.
 *   3. At least one collected test failed (`×`/`✗` test line, `Tests  N failed`,
 *      ` FAIL  <file> > <name>`) → genuine, never infra. A run mixing a broken
 *      suite with a real test failure is still a real failure.
 *   4. A suite-level ` FAIL  <file> [ <file> ]` line co-occurring with a
 *      module/dist-resolution error (`Cannot find module`, `Failed to load url`,
 *      `ERR_MODULE_NOT_FOUND`, `Failed to resolve import`) → infra. This is
 *      what a test importing an unbuilt `../dist/…` looks like in vitest 3.
 *   5. A bare module-resolution error with no evidence any test ran → infra.
 *   6. Anything else (including anything ambiguous) → genuine outcome, so a
 *      real failure is never masked.
 *
 * Before this ordering, rule 3's old form (`\bFAIL\b` / `Test Files N failed`
 * ⇒ "ran tests") short-circuited ahead of the resolution signatures, so every
 * dist-resolving monorepo classified a broken base env as a genuine base
 * failure and the proof degenerated to "does the branch pass".
 */
export function isInfraFailure(output: string, exitCode?: number): boolean {
  if (isRunnerNotFound(output, exitCode)) return true;
  if (isZeroTestsCollected(output)) return true;
  if (hasTestLevelFailure(output)) return false;
  if (hasSuiteLevelFailure(output) && hasModuleResolutionError(output)) return true;
  if (hasModuleResolutionError(output) && !hasRunEvidence(output)) return true;
  return false;
}

/**
 * Short, log-safe discriminator for the matched infra signature. Assumes
 * `isInfraFailure(output, exitCode)` already returned `true`; returns `unknown`
 * otherwise. Ordered to mirror the classifier so the reported reason is the
 * rule that actually fired.
 */
function infraSignature(output: string, exitCode?: number): string {
  if (isRunnerNotFound(output, exitCode)) return 'vitest-not-found';
  if (/No test files found/.test(output)) return 'no-test-files';
  if (/Cannot find module/.test(output)) return 'cannot-find-module';
  if (/Failed to resolve import/.test(output)) return 'failed-to-resolve-import';
  if (/Failed to load url/.test(output)) return 'failed-to-load-url';
  if (/ERR_MODULE_NOT_FOUND/.test(output)) return 'err-module-not-found';
  if (/Tests\s+no tests\b/.test(output)) return 'no-tests-collected';
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
  /** Process exit code when the run exited non-zero (undefined on exit 0 / kill). */
  exitCode?: number;
}

type RunVerdict = 'pass' | 'fail' | 'infra' | 'timeout';

/**
 * Collapse a run into the verdict the proof reasons about. `infra` is checked
 * BEFORE the exit code so a run that exited 0 without exercising anything (e.g.
 * `passWithNoTests`, or pnpm's exit-0 "No projects matched") can never be read
 * as a `pass` — on the base side that would be a phantom `base-passed`, and a
 * base `skip` must never count as fail-on-base satisfied either.
 */
function verdictOf(outcome: TestRunOutcome): RunVerdict {
  if (outcome.timedOut) return 'timeout';
  if (isInfraFailure(outcome.output, outcome.exitCode)) return 'infra';
  return outcome.passed ? 'pass' : 'fail';
}

/**
 * Spawn one `pnpm <args>` in `cwd`. Never throws on a non-zero exit — it is
 * captured as `{ passed: false, exitCode }`. A run that overruns
 * BASE_TEST_TIMEOUT_MS is killed and reported as `{ timedOut: true }` (FR-006);
 * an `AbortError` from the caller's phase `signal` propagates (must not be
 * converted into a spurious finding).
 */
async function spawnPnpm(
  cwd: string,
  args: string[],
  signal: AbortSignal
): Promise<TestRunOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync('pnpm', args, {
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
      code?: string | number | null;
      name?: string;
    };
    // An AbortError from the phase signal must propagate — it means the whole
    // phase was cancelled, not that the tests produced a verdict.
    if (e.name === 'AbortError' || signal.aborted) {
      throw err;
    }
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || (e.message ?? String(err));
    const timedOut = e.killed === true || e.code === 'ETIMEDOUT';
    const exitCode = typeof e.code === 'number' ? e.code : undefined;
    return { passed: false, output, timedOut, exitCode };
  }
}

/**
 * Group repo-relative test files by the package that owns them: the nearest
 * ancestor directory (walking up from the file, stopping at `root`) holding a
 * `package.json`. Files owned by the root itself are dropped — the root has
 * already been shown to have no vitest, so re-running there is pointless.
 * Returns `[packageDir (repo-relative), files (package-relative)]` pairs in
 * first-seen order.
 */
async function groupByOwningPackage(
  root: string,
  files: string[]
): Promise<Array<{ packageDir: string; files: string[] }>> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    let dir = dirname(file);
    let owner: string | undefined;
    while (dir !== '' && dir !== '.') {
      try {
        await stat(join(root, dir, 'package.json'));
        owner = dir;
        break;
      } catch {
        /* not here — keep walking up */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (owner === undefined) continue;
    const list = groups.get(owner) ?? [];
    list.push(relative(owner, file));
    groups.set(owner, list);
  }
  return [...groups.entries()].map(([packageDir, pkgFiles]) => ({
    packageDir,
    files: pkgFiles,
  }));
}

/**
 * Run the given test files with vitest in `cwd`.
 *
 * First tries the root `pnpm vitest run <files>`. When that fails because the
 * root has no vitest (a workspace where vitest is only a package devDependency;
 * pnpm prints `Command "vitest" not found`, exit 254), the files are re-run
 * through the package that owns each of them — `pnpm --dir <pkg> exec vitest
 * run <package-relative files>` — which passes vitest's own exit code straight
 * through. (`--filter <name>` is deliberately NOT used: it wraps a genuine
 * failure in `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` and exits 0 for an unknown
 * name.) If no owning package can be found the root outcome is returned, which
 * the caller classifies as an infra `skip` (`vitest-not-found`), never as a
 * `branch-failed`/`base-passed` verdict.
 */
async function runTests(
  cwd: string,
  files: string[],
  signal: AbortSignal
): Promise<TestRunOutcome> {
  const root = await spawnPnpm(cwd, ['vitest', 'run', ...files], signal);
  if (root.timedOut || !isRunnerNotFound(root.output, root.exitCode)) {
    return root;
  }

  const groups = await groupByOwningPackage(cwd, files);
  if (groups.length === 0) {
    return root;
  }

  const outcomes: TestRunOutcome[] = [];
  for (const group of groups) {
    const outcome = await spawnPnpm(
      cwd,
      ['--dir', group.packageDir, 'exec', 'vitest', 'run', ...group.files],
      signal
    );
    if (outcome.timedOut) {
      return outcome;
    }
    outcomes.push({
      ...outcome,
      output: `[pnpm --dir ${group.packageDir} exec vitest run ${group.files.join(' ')}]\n${
        outcome.output
      }`,
    });
  }
  const firstFailure = outcomes.find((o) => !o.passed);
  return {
    passed: firstFailure === undefined,
    output: outcomes.map((o) => o.output).join('\n\n'),
    timedOut: false,
    exitCode: firstFailure?.exitCode,
  };
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
  // `verdictOf` checks infra BEFORE the exit code, so a base `skip` is reported
  // as a skip with its reason and never silently counts as fail-on-base
  // satisfied (nor, on an exit-0 no-op run, as base-passed).
  const baseVerdict = verdictOf(baseOutcome);
  if (baseVerdict === 'timeout') {
    return { kind: 'skip', reason: 'timeout' };
  }
  if (baseVerdict === 'infra') {
    return {
      kind: 'skip',
      reason: `infra:${infraSignature(baseOutcome.output, baseOutcome.exitCode)} at base ref`,
    };
  }

  if (baseVerdict === 'pass') {
    return {
      kind: 'fail',
      reason: 'base-passed',
      evidence:
        `The changed test file(s) PASSED against the base ref \`${baseRef}\` source, so ` +
        `they do not reproduce the bug. Add a test that fails without the fix.\n\n${baseOutcome.output}`,
    };
  }

  const branchOutcome = await runTests(checkoutPath, effectiveTestFiles, signal);
  // A branch run that timed out or infra-failed (e.g. no root vitest and no
  // owning package with vitest → runner never started, FR-005) is a broken
  // branch env, never a `branch-failed` verdict — skip.
  const branchVerdict = verdictOf(branchOutcome);
  if (branchVerdict === 'timeout') {
    return { kind: 'skip', reason: 'timeout' };
  }
  if (branchVerdict === 'infra') {
    return {
      kind: 'skip',
      reason: `infra:${infraSignature(branchOutcome.output, branchOutcome.exitCode)} on branch`,
    };
  }
  if (branchVerdict === 'fail') {
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
