import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { WorkspaceConfig } from './workspace-schema.js';

/**
 * Returns all repos from the workspace config with owner/repo info.
 */
export function getWorkspaceRepos(
  config: WorkspaceConfig,
): { owner: string; repo: string }[] {
  return config.repos.map((r) => ({ owner: config.org, repo: r.name }));
}

/**
 * Returns only repos where `monitor` is true (the default).
 */
export function getMonitoredRepos(
  config: WorkspaceConfig,
): { owner: string; repo: string }[] {
  return config.repos
    .filter((r) => r.monitor)
    .map((r) => ({ owner: config.org, repo: r.name }));
}

/**
 * Returns bare repo names from the workspace config.
 */
export function getRepoNames(config: WorkspaceConfig): string[] {
  return config.repos.map((r) => r.name);
}

/**
 * Returns the local working directory path for a repo.
 */
export function getRepoWorkdir(
  repoName: string,
  basePath: string = '/workspaces',
): string {
  return `${basePath}/${repoName}`;
}

/**
 * Normalize a path via realpathSync (resolves symlinks).
 * Falls back to path.resolve() if the path doesn't exist or realpathSync throws.
 */
function normalizePath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Resolves sibling working directories from workspace config.
 * Returns a map of repo name → absolute path for all repos
 * except the primary (identified by matching against primaryWorkdir).
 *
 * Returns empty map if:
 * - No repo path matches primaryWorkdir (fail closed)
 * - All sibling paths don't exist on disk
 */
export function resolveSiblingWorkdirs(
  config: WorkspaceConfig,
  primaryWorkdir: string,
  basePath?: string,
): Record<string, string> {
  const resolvedBase = basePath ?? dirname(resolve(primaryWorkdir));
  const normalizedPrimary = normalizePath(primaryWorkdir);

  const result: Record<string, string> = {};
  let foundPrimary = false;

  for (const repo of config.repos) {
    const candidatePath = getRepoWorkdir(repo.name, resolvedBase);
    const normalizedCandidate = normalizePath(candidatePath);

    if (normalizedCandidate === normalizedPrimary) {
      foundPrimary = true;
      continue;
    }

    if (!existsSync(candidatePath)) {
      continue;
    }

    result[repo.name] = normalizedCandidate;
  }

  if (!foundPrimary) {
    return {};
  }

  return result;
}
