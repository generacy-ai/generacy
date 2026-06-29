import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GhWrapper } from '../gh/wrapper.js';
import { GhCliWrapper } from '../gh/wrapper.js';
import { readManifest } from './io.js';

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
   * `CockpitConfig.repos`. The function unions this with the epic's own repo
   * and deduplicates.
   *
   * When omitted (library used outside the CLI), the function searches only
   * the epic's own repo AND emits a structured warning via `logger.warn`
   * naming the limitation (FR-005).
   */
  repos?: string[];
}

const ISSUE_REF_REGEX = /^([^/]+\/[^/]+)#(\d+)$/;

function parseIssueRef(ref: string): IssueRef | null {
  const m = ISSUE_REF_REGEX.exec(ref);
  if (m == null) return null;
  const n = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { repo: m[1]!, number: n };
}

function sortAndDedupIssueRefs(refs: Iterable<IssueRef>): IssueRef[] {
  const seen = new Map<string, IssueRef>();
  for (const ref of refs) {
    const key = `${ref.repo}#${ref.number}`;
    if (!seen.has(key)) seen.set(key, ref);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.repo < b.repo) return -1;
    if (a.repo > b.repo) return 1;
    return a.number - b.number;
  });
}

function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

async function readManifestFiles(
  manifestRoot: string,
  logger?: { warn: (msg: string) => void },
): Promise<Array<{ path: string; manifest: Awaited<ReturnType<typeof readManifest>> }>> {
  if (!existsSync(manifestRoot)) return [];
  const entries = await readdir(manifestRoot);
  const yamlFiles = entries.filter((e) => e.endsWith('.yaml') || e.endsWith('.yml')).sort();
  const out: Array<{ path: string; manifest: Awaited<ReturnType<typeof readManifest>> }> = [];
  for (const file of yamlFiles) {
    const path = join(manifestRoot, file);
    try {
      const manifest = await readManifest(path);
      out.push({ path, manifest });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.warn(`cockpit: skipped malformed manifest ${path}: ${msg}`);
    }
  }
  return out;
}

/**
 * Resolve the set of child issue refs belonging to a given epic.
 *
 * Resolution order:
 *   1. Glob `.generacy/epics/*.yaml`; if any manifest matches epic+repo, return
 *      every `phases[*].issues` entry as an `IssueRef` (cross-repo entries
 *      preserved).
 *   2. Otherwise fall back to `gh search` across `repos ∪ {epicRepo}`. Per
 *      repo, run both the `label:epic-child` and `in:body` queries.
 *
 * Output is sorted ascending by `(repo, number)` and deduped by the same key.
 */
export async function resolveEpicIssues(
  epic: number,
  owner: string,
  repo: string,
  options: ResolveEpicIssuesOptions = {},
): Promise<IssueRef[]> {
  const cwd = options.cwd ?? process.cwd();
  const manifestRoot = options.manifestRoot ?? join(cwd, '.generacy', 'epics');
  const ownerRepo = `${owner}/${repo}`;

  const manifests = await readManifestFiles(manifestRoot, options.logger);
  for (const entry of manifests) {
    const m = entry.manifest;
    if (m == null) continue;
    if (m.epic.issue !== epic) continue;
    if (m.epic.repo !== ownerRepo) continue;
    const refs: IssueRef[] = [];
    for (const phase of m.phases) {
      for (const ref of phase.issues) {
        const parsed = parseIssueRef(ref);
        if (parsed != null) refs.push(parsed);
      }
    }
    return sortAndDedupIssueRefs(refs);
  }

  // No matching manifest — fall back to gh search across the configured repos.
  const gh = options.gh ?? new GhCliWrapper();

  if (options.repos == null || options.repos.length === 0) {
    options.logger?.warn(
      `cockpit: resolveEpicIssues called without configured repos; searching epic repo only (${ownerRepo}). Cross-repo children will not be discovered.`,
    );
  }

  const repoSet = uniqueStrings([...(options.repos ?? []), ownerRepo]);

  const merged: IssueRef[] = [];
  for (const R of repoSet) {
    const childLabelQuery = `repo:${R} is:issue label:epic-child ${ownerRepo}#${epic}`;
    const bodyRefQuery = `repo:${R} is:issue ${ownerRepo}#${epic} in:body`;
    const [labelHits, bodyHits] = await Promise.all([
      gh.listIssues(childLabelQuery),
      gh.listIssues(bodyRefQuery),
    ]);
    for (const issue of labelHits) merged.push({ repo: R, number: issue.number });
    for (const issue of bodyHits) merged.push({ repo: R, number: issue.number });
  }

  return sortAndDedupIssueRefs(merged);
}
