import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GhWrapper } from '../gh/wrapper.js';
import { GhCliWrapper } from '../gh/wrapper.js';
import { readManifest } from './io.js';

export interface ResolveEpicIssuesOptions {
  manifestRoot?: string;
  gh?: GhWrapper;
  cwd?: string;
  logger?: { warn: (msg: string) => void };
}

function parseIssueRefNumber(ref: string, ownerRepo: string): number | null {
  const prefix = `${ownerRepo}#`;
  if (!ref.startsWith(prefix)) return null;
  const n = Number.parseInt(ref.slice(prefix.length), 10);
  return Number.isFinite(n) ? n : null;
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
 * Resolve the set of child issue numbers belonging to a given epic.
 *
 * Resolution order (plan.md §D5):
 *   1. Glob `.generacy/epics/*.yaml`; if any manifest matches epic+repo, return the
 *      union of `phases[*].issues` filtered to `owner/repo#n` entries.
 *   2. Otherwise fall back to two `gh search` queries (epic-child label + body
 *      reference); merge + dedupe and return numbers.
 */
export async function resolveEpicIssues(
  epic: number,
  owner: string,
  repo: string,
  options: ResolveEpicIssuesOptions = {},
): Promise<number[]> {
  const cwd = options.cwd ?? process.cwd();
  const manifestRoot = options.manifestRoot ?? join(cwd, '.generacy', 'epics');
  const ownerRepo = `${owner}/${repo}`;

  const manifests = await readManifestFiles(manifestRoot, options.logger);
  for (const entry of manifests) {
    const m = entry.manifest;
    if (m == null) continue;
    if (m.epic.issue !== epic) continue;
    if (m.epic.repo !== ownerRepo) continue;
    const found = new Set<number>();
    for (const phase of m.phases) {
      for (const ref of phase.issues) {
        const n = parseIssueRefNumber(ref, ownerRepo);
        if (n != null) found.add(n);
      }
    }
    return [...found].sort((a, b) => a - b);
  }

  // No matching manifest — fall back to gh search.
  const gh = options.gh ?? new GhCliWrapper();
  const childLabelQuery = `repo:${ownerRepo} is:issue label:epic-child #${epic}`;
  const bodyRefQuery = `repo:${ownerRepo} is:issue ${ownerRepo}#${epic} in:body`;

  const [labelHits, bodyHits] = await Promise.all([
    gh.listIssues(childLabelQuery),
    gh.listIssues(bodyRefQuery),
  ]);

  const merged = new Set<number>();
  for (const issue of labelHits) merged.add(issue.number);
  for (const issue of bodyHits) merged.add(issue.number);
  return [...merged].sort((a, b) => a - b);
}
