// Contract: resolveEpicIssues — post-#801
//
// This file is a TypeScript-as-interface contract. It is not built or imported
// by the package; it pins the function's public shape and behavioral
// invariants. Source of truth at implementation time is
// packages/cockpit/src/manifest/scoping.ts.

import type { GhWrapper } from '../../../packages/cockpit/src/gh/wrapper.js';

/**
 * Repo-qualified reference to a GitHub issue or PR.
 *
 * - `repo` is the full `owner/repo` form (matches what `gh --repo` accepts).
 * - `number` is the issue or PR number (positive integer).
 *
 * Equality / dedup: by tuple `(repo, number)`.
 * Sort: ascending lexicographic by `repo`, then ascending by `number`.
 */
export interface IssueRef {
  repo: string;
  number: number;
}

export interface ResolveEpicIssuesOptions {
  manifestRoot?: string;
  gh?: GhWrapper;
  cwd?: string;
  logger?: { warn: (msg: string) => void };
  /**
   * Repos to iterate in the no-manifest fallback. Caller passes
   * `CockpitConfig.repos`. Union with the epic's own repo, dedup.
   * Omitted ⇒ search only the epic's own repo + emit FR-005 warning.
   */
  repos?: string[];
}

/**
 * Resolve the set of child issue refs belonging to a given epic.
 *
 * Resolution order:
 *
 *   1. Glob `.generacy/epics/*.yaml`. If a manifest matches both `epic.issue`
 *      and `epic.repo === ${owner}/${repo}`, return every `phases[*].issues`
 *      entry as an `IssueRef`. Entries in repos *other than* the epic's repo
 *      are KEPT (the bug fix).
 *
 *   2. Otherwise fall back to `gh search`:
 *      - Let `repoSet = unique([...(options.repos ?? []), `${owner}/${repo}`])`.
 *      - For each `R in repoSet`, run BOTH queries:
 *          repo:R is:issue label:epic-child <owner>/<repo>#<epic>
 *          repo:R is:issue <owner>/<repo>#<epic> in:body
 *      - Merge and dedup by `(R, issue.number)`.
 *
 * Behavioral guarantees:
 * - Output is sorted ascending by `(repo, number)` for stable test output.
 * - Malformed manifests are skipped with `logger.warn` (existing behavior).
 * - When `options.repos` is omitted, a structured warning is logged naming the
 *   limitation, and the function falls back to `[ownerRepo]` only.
 * - Cross-repo entries in a valid manifest are NEVER filtered out (the bug).
 */
export declare function resolveEpicIssues(
  epic: number,
  owner: string,
  repo: string,
  options?: ResolveEpicIssuesOptions,
): Promise<IssueRef[]>;
