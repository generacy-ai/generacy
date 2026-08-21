import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { PrManager } from './pr-manager.js';

/**
 * Path prefixes of engine bookkeeping sidecars (#1162).
 *
 * Single source of truth consumed by BOTH the phase-completion staging filter
 * (`PrManager.commitAndPush`, FR-001) and the product-diff exclusion (FR-004),
 * so the two can never drift. Matched via literal `String.prototype.startsWith`
 * against the exact filename stems the sidecar writers emit — so they match
 * `<prefix><sanitized-id>.json` but never `.generacy/config.yaml` or
 * `.generacy/epics/*` (Q3, legitimately tracked product files).
 */
export const ENGINE_SIDECAR_PREFIXES = [
  '.generacy/review-findings-',
  '.generacy/review-candidate-',
  '.generacy/pause-context-',
] as const;

/** True when `p` is an engine bookkeeping sidecar (#1162). */
export function isEngineSidecar(p: string): boolean {
  return ENGINE_SIDECAR_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Path prefixes excluded from the "product diff" check.
 *
 * Matched via `String.prototype.startsWith` — literal prefix, no glob, no regex,
 * no path normalization. Colocated with `PHASES_REQUIRING_CHANGES` (in
 * `phase-loop.ts`) as a module-level constant per Clarification Q1: no
 * `WorkerConfig` field, no YAML key.
 */
export const EXCLUDED_PATH_PREFIXES: readonly string[] = ['specs/', ...ENGINE_SIDECAR_PREFIXES];

/**
 * Exact repo-root file paths excluded from the "product diff" check (#1107).
 *
 * These are the spec-kit `update_agent` targets, written at repo root by the
 * specify phase. Matched by exact string equality against the root-relative
 * path — NOT `startsWith` (which would swallow `CLAUDE.md.bak`) and NOT
 * basename-at-any-depth (which would exclude genuine `packages/<pkg>/CLAUDE.md`
 * documentation work). Module-level constant per Clarification Q1 (no
 * `WorkerConfig` field, no YAML key).
 */
export const EXCLUDED_EXACT_PATHS: readonly string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
];

export interface ProductDiffResult {
  /** Every file returned by `git diff --name-only base...HEAD`. */
  changedFiles: string[];
  /** Subset of changedFiles whose path does NOT start with any excluded prefix. */
  productFiles: string[];
  /** The base ref actually used for comparison, e.g. `origin/develop`. */
  baseRef: string;
}

/**
 * Returns `true` when `path` is NOT under any excluded prefix and does NOT
 * exactly equal any excluded root-relative path.
 *
 * @param prefixes Defaults to `EXCLUDED_PATH_PREFIXES`; injected for tests.
 * @param exactPaths Defaults to `EXCLUDED_EXACT_PATHS`; injected for tests.
 */
export function isProductFile(
  path: string,
  prefixes: readonly string[] = EXCLUDED_PATH_PREFIXES,
  exactPaths: readonly string[] = EXCLUDED_EXACT_PATHS,
): boolean {
  return !prefixes.some((prefix) => path.startsWith(prefix)) && !exactPaths.includes(path);
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

/**
 * Phase-scoped product diff (#1107).
 *
 * Measures only the files touched by the branch's OWN commits since `startRef`
 * (first-parent, no-merges), so base-merge-introduced and earlier-phase files
 * never satisfy the guard. Used by the implement-phase step-5b guard in place
 * of the cumulative `computeProductDiff` window.
 *
 * The result's `baseRef` field carries `startRef` for diagnostics.
 */
export async function computePhaseScopedProductDiff(
  github: GitHubClient,
  startRef: string,
): Promise<ProductDiffResult> {
  const changedFiles = await github.getFilesChangedByOwnCommits(startRef);
  const productFiles = changedFiles.filter((p) => isProductFile(p));
  return { changedFiles: [...changedFiles], productFiles, baseRef: startRef };
}
