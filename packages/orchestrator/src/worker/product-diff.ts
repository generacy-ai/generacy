import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { PrManager } from './pr-manager.js';

/**
 * Path prefixes excluded from the "product diff" check.
 *
 * Matched via `String.prototype.startsWith` — literal prefix, no glob, no regex,
 * no path normalization. Colocated with `PHASES_REQUIRING_CHANGES` (in
 * `phase-loop.ts`) as a module-level constant per Clarification Q1: no
 * `WorkerConfig` field, no YAML key.
 */
export const EXCLUDED_PATH_PREFIXES: readonly string[] = ['specs/'];

export interface ProductDiffResult {
  /** Every file returned by `git diff --name-only base...HEAD`. */
  changedFiles: string[];
  /** Subset of changedFiles whose path does NOT start with any excluded prefix. */
  productFiles: string[];
  /** The base ref actually used for comparison, e.g. `origin/develop`. */
  baseRef: string;
}

/**
 * Returns `true` when `path` is NOT under any excluded prefix.
 *
 * @param prefixes Defaults to `EXCLUDED_PATH_PREFIXES`; injected for tests.
 */
export function isProductFile(
  path: string,
  prefixes: readonly string[] = EXCLUDED_PATH_PREFIXES,
): boolean {
  return !prefixes.some((prefix) => path.startsWith(prefix));
}

/**
 * Resolve the base ref to diff against, formatted as `origin/<ref>`.
 *
 * If the workflow has a PR (getPrNumber() defined), diff against that PR's
 * base branch. Otherwise fall back to the repository default branch.
 */
export async function resolveBaseRef(
  github: GitHubClient,
  prManager: PrManager,
  owner: string,
  repo: string,
): Promise<string> {
  const prNumber = prManager.getPrNumber();
  if (prNumber !== undefined) {
    const pr = await github.getPullRequest(owner, repo, prNumber);
    return `origin/${pr.base.ref}`;
  }
  const defaultBranch = await github.getDefaultBranch();
  return `origin/${defaultBranch}`;
}

/**
 * Cumulative branch diff against `baseRef`, partitioned by exclusion list.
 *
 * Returns freshly-allocated arrays; does not mutate inputs.
 */
export async function computeProductDiff(
  github: GitHubClient,
  baseRef: string,
): Promise<ProductDiffResult> {
  const changedFiles = await github.getFilesChangedBetween(baseRef, 'HEAD');
  const productFiles = changedFiles.filter((p) => isProductFile(p));
  return { changedFiles: [...changedFiles], productFiles, baseRef };
}
