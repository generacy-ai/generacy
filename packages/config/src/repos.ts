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
