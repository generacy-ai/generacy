import { describe, expect, it } from 'vitest';
import {
  getWorkspaceRepos,
  getMonitoredRepos,
  getRepoNames,
  getRepoWorkdir,
} from '../repos.js';
import type { WorkspaceConfig } from '../workspace-schema.js';

const singleRepoConfig: WorkspaceConfig = {
  org: 'generacy-ai',
  branch: 'develop',
  repos: [{ name: 'generacy', monitor: true }],
};

const multiRepoConfig: WorkspaceConfig = {
  org: 'generacy-ai',
  branch: 'develop',
  repos: [
    { name: 'tetrad-development', monitor: true },
    { name: 'generacy', monitor: true },
    { name: 'contracts', monitor: false },
    { name: 'cluster-templates', monitor: true },
  ],
};

describe('getWorkspaceRepos', () => {
  it('returns all repos with owner from org', () => {
    const repos = getWorkspaceRepos(multiRepoConfig);
    expect(repos).toEqual([
      { owner: 'generacy-ai', repo: 'tetrad-development' },
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'contracts' },
      { owner: 'generacy-ai', repo: 'cluster-templates' },
    ]);
  });

  it('includes repos regardless of monitor flag', () => {
    const repos = getWorkspaceRepos(multiRepoConfig);
    expect(repos).toHaveLength(4);
    expect(repos).toContainEqual({ owner: 'generacy-ai', repo: 'contracts' });
  });

  it('works with a single repo', () => {
    const repos = getWorkspaceRepos(singleRepoConfig);
    expect(repos).toEqual([{ owner: 'generacy-ai', repo: 'generacy' }]);
  });

  it('uses the config org as owner for every repo', () => {
    const config: WorkspaceConfig = {
      org: 'other-org',
      branch: 'main',
      repos: [
        { name: 'repo-a', monitor: true },
        { name: 'repo-b', monitor: false },
      ],
    };
    const repos = getWorkspaceRepos(config);
    expect(repos.every((r) => r.owner === 'other-org')).toBe(true);
  });
});

describe('getMonitoredRepos', () => {
  it('returns only repos with monitor: true', () => {
    const repos = getMonitoredRepos(multiRepoConfig);
    expect(repos).toEqual([
      { owner: 'generacy-ai', repo: 'tetrad-development' },
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'cluster-templates' },
    ]);
  });

  it('excludes repos with monitor: false', () => {
    const repos = getMonitoredRepos(multiRepoConfig);
    expect(repos).not.toContainEqual({ owner: 'generacy-ai', repo: 'contracts' });
  });

  it('returns all repos when all are monitored', () => {
    const config: WorkspaceConfig = {
      org: 'generacy-ai',
      branch: 'develop',
      repos: [
        { name: 'repo-a', monitor: true },
        { name: 'repo-b', monitor: true },
      ],
    };
    const repos = getMonitoredRepos(config);
    expect(repos).toHaveLength(2);
  });

  it('returns empty array when no repos are monitored', () => {
    const config: WorkspaceConfig = {
      org: 'generacy-ai',
      branch: 'develop',
      repos: [
        { name: 'repo-a', monitor: false },
        { name: 'repo-b', monitor: false },
      ],
    };
    const repos = getMonitoredRepos(config);
    expect(repos).toEqual([]);
  });
});

describe('getRepoNames', () => {
  it('returns bare repo names', () => {
    const names = getRepoNames(multiRepoConfig);
    expect(names).toEqual([
      'tetrad-development',
      'generacy',
      'contracts',
      'cluster-templates',
    ]);
  });

  it('includes all repos regardless of monitor flag', () => {
    const names = getRepoNames(multiRepoConfig);
    expect(names).toHaveLength(4);
    expect(names).toContain('contracts');
  });

  it('works with a single repo', () => {
    const names = getRepoNames(singleRepoConfig);
    expect(names).toEqual(['generacy']);
  });
});

describe('getRepoWorkdir', () => {
  it('returns path under default /workspaces base', () => {
    expect(getRepoWorkdir('generacy')).toBe('/workspaces/generacy');
  });

  it('returns path under custom base path', () => {
    expect(getRepoWorkdir('generacy', '/home/user/projects')).toBe(
      '/home/user/projects/generacy',
    );
  });

  it('handles repo names with hyphens', () => {
    expect(getRepoWorkdir('tetrad-development')).toBe(
      '/workspaces/tetrad-development',
    );
  });
});
