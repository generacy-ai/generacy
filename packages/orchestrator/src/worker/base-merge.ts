import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { Logger } from './types.js';
import type { PrManager } from './pr-manager.js';
import { resolveBaseRef } from './product-diff.js';

const execFileAsync = promisify(execFile);

/**
 * Result of `performBaseMerge`. Discriminated union on `ok`.
 *
 * See specs/864-found-during-cockpit-v1/data-model.md §BaseMergeResult.
 */
export type BaseMergeResult =
  | {
      ok: true;
      /** The `origin/<base>` ref that was merged. */
      baseRef: string;
      /** SHA of the resulting merge commit. Only present when opts.commit === true. */
      mergeSha?: string;
    }
  | {
      ok: false;
      baseRef: string;
      /** Paths reported by `git diff --name-only --diff-filter=U`. Guaranteed non-empty. */
      conflictedPaths: string[];
    };

/**
 * Options controlling the runner's commit behavior.
 *
 * - `commit: true` — the merge is committed onto the feature branch (implement phase, per FR-013).
 * - `commit: false` — `git merge --no-ff --no-commit`; state is left as an un-committed merge
 *   and MUST be discarded by the next phase's reset-at-start (FR-006, ephemeral).
 */
export interface BaseMergeOptions {
  commit: boolean;
}

/**
 * DI seam for phase-loop tests. Default implementation is `performBaseMerge`.
 */
export interface BaseMergeRunner {
  (
    checkoutPath: string,
    branch: string,
    baseRef: string,
    opts: BaseMergeOptions,
    logger: Logger,
  ): Promise<BaseMergeResult>;
}

/**
 * Sentinel placeholder inserted when git returned no conflicted paths on a merge failure.
 * Guarantees `conflictedPaths` is non-empty on `ok: false` (data-model.md §Validation).
 */
const UNKNOWN_CONFLICT_PLACEHOLDER = '<unknown: merge failed without conflict list>';

/**
 * Resolve the base branch to merge into the feature branch, formatted as `origin/<name>`.
 *
 * Delegates to the existing `resolveBaseRef` (from product-diff.ts) so the base ref
 * derivation stays consistent across the codebase: PR base if the workflow has a PR,
 * repo default branch otherwise. Per FR-011 + research.md §"base ref from PR".
 */
export async function resolveBaseBranch(
  github: GitHubClient,
  prManager: PrManager,
  _checkoutPath: string,
  owner: string,
  repo: string,
  _logger: Logger,
): Promise<string> {
  return resolveBaseRef(github, prManager, owner, repo);
}

/**
 * Perform a base-merge of `baseRef` into the currently-checked-out feature branch.
 *
 * See specs/864-found-during-cockpit-v1/contracts/base-merge-runner.md §Behavior.
 *
 * Non-conflict git failures (network / bad ref) throw `Error` — they are NOT converted
 * to `{ ok: false }`. The `ok: false` variant is reserved for actual merge conflicts.
 */
export async function performBaseMerge(
  checkoutPath: string,
  branch: string,
  baseRef: string,
  opts: BaseMergeOptions,
  logger: Logger,
): Promise<BaseMergeResult> {
  if (!baseRef.startsWith('origin/')) {
    throw new Error(`performBaseMerge: baseRef must start with 'origin/' (got '${baseRef}')`);
  }
  const baseBranchName = baseRef.slice('origin/'.length);

  logger.info(
    { checkoutPath, branch, baseRef, commit: opts.commit },
    'Base-merge: starting',
  );

  // Step 1: reset to branch tip — discard any workspace-local state.
  await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], {
    cwd: checkoutPath,
  });
  await execFileAsync('git', ['clean', '-fd'], { cwd: checkoutPath });

  // Step 2: fresh fetch of the base ref.
  await execFileAsync('git', ['fetch', 'origin', baseBranchName], {
    cwd: checkoutPath,
  });

  // Step 3: git merge (committed for implement, ephemeral for pre-validate/validate).
  const mergeArgs = ['merge', '--no-ff'];
  if (!opts.commit) mergeArgs.push('--no-commit');
  mergeArgs.push(baseRef);

  try {
    await execFileAsync('git', mergeArgs, { cwd: checkoutPath });
  } catch (mergeErr) {
    // Merge failed — could be a conflict (expected) or a non-conflict failure.
    let conflictedPaths: string[] = [];
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd: checkoutPath },
      );
      conflictedPaths = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (diffErr) {
      logger.warn(
        { err: String(diffErr) },
        'Base-merge: could not enumerate conflicted paths after merge failure',
      );
    }

    // Abort the merge so the working tree returns to a clean state.
    try {
      await execFileAsync('git', ['merge', '--abort'], { cwd: checkoutPath });
    } catch (abortErr) {
      logger.warn(
        { err: String(abortErr) },
        'Base-merge: git merge --abort failed (working tree may still be dirty; next phase reset will clean)',
      );
    }

    if (conflictedPaths.length === 0) {
      // Non-conflict git failure: propagate (contracts/base-merge-runner.md §"Error propagation").
      // But if git DID report a merge failure with no conflict paths, we still guarantee
      // conflictedPaths is non-empty via placeholder (data-model.md §Validation).
      const stderr = (mergeErr as { stderr?: string } | undefined)?.stderr ?? '';
      const message = (mergeErr as Error).message ?? '';
      const looksLikeConflict = /conflict/i.test(stderr) || /conflict/i.test(message);
      if (!looksLikeConflict) {
        // Genuine non-conflict failure: rethrow.
        throw mergeErr;
      }
      conflictedPaths = [UNKNOWN_CONFLICT_PLACEHOLDER];
    }

    logger.warn(
      { checkoutPath, branch, baseRef, conflictedPaths },
      'Base-merge: conflict detected',
    );
    return { ok: false, baseRef, conflictedPaths };
  }

  // Merge succeeded.
  if (opts.commit) {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: checkoutPath,
    });
    const mergeSha = stdout.trim();
    logger.info(
      { checkoutPath, branch, baseRef, mergeSha },
      'Base-merge: committed merge succeeded',
    );
    return { ok: true, baseRef, mergeSha };
  }

  logger.info(
    { checkoutPath, branch, baseRef },
    'Base-merge: ephemeral merge succeeded (no commit)',
  );
  return { ok: true, baseRef };
}
