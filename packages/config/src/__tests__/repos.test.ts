import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getWorkspaceRepos,
  getMonitoredRepos,
  getRepoNames,
  getRepoWorkdir,
  resolveSiblingWorkdirs,
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
    { name: 'cluster-base', monitor: true },
  ],
};

describe('getWorkspaceRepos', () => {
  it('returns all repos with owner from org', () => {
    const repos = getWorkspaceRepos(multiRepoConfig);
    expect(repos).toEqual([
      { owner: 'generacy-ai', repo: 'tetrad-development' },
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'contracts' },
      { owner: 'generacy-ai', repo: 'cluster-base' },
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
      { owner: 'generacy-ai', repo: 'cluster-base' },
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
      'cluster-base',
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

describe('resolveSiblingWorkdirs', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'repos-test-'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('excludes primary repo from sibling map', () => {
    // Create directories for all repos
    mkdirSync(join(tmpBase, 'primary'));
    mkdirSync(join(tmpBase, 'sibling-a'));
    mkdirSync(join(tmpBase, 'sibling-b'));

    const config: WorkspaceConfig = {
      org: 'test-org',
      branch: 'develop',
      repos: [
        { name: 'primary', monitor: true },
        { name: 'sibling-a', monitor: true },
        { name: 'sibling-b', monitor: true },
      ],
    };

    const result = resolveSiblingWorkdirs(config, join(tmpBase, 'primary'), tmpBase);
    expect(result).not.toHaveProperty('primary');
    expect(result).toHaveProperty('sibling-a');
    expect(result).toHaveProperty('sibling-b');
  });

  it('skips non-existent sibling paths', () => {
    mkdirSync(join(tmpBase, 'primary'));
    mkdirSync(join(tmpBase, 'existing'));
    // 'missing' directory not created

    const config: WorkspaceConfig = {
      org: 'test-org',
      branch: 'develop',
      repos: [
        { name: 'primary', monitor: true },
        { name: 'existing', monitor: true },
        { name: 'missing', monitor: true },
      ],
    };

    const result = resolveSiblingWorkdirs(config, join(tmpBase, 'primary'), tmpBase);
    expect(result).toHaveProperty('existing');
    expect(result).not.toHaveProperty('missing');
  });

  it('returns empty map for empty repos list', () => {
    mkdirSync(join(tmpBase, 'primary'));

    const config: WorkspaceConfig = {
      org: 'test-org',
      branch: 'develop',
      repos: [{ name: 'primary', monitor: true }],
    };

    const result = resolveSiblingWorkdirs(config, join(tmpBase, 'primary'), tmpBase);
    expect(result).toEqual({});
  });

  it('returns empty map when no repo matches primary', () => {
    mkdirSync(join(tmpBase, 'repo-a'));
    mkdirSync(join(tmpBase, 'repo-b'));

    const config: WorkspaceConfig = {
      org: 'test-org',
      branch: 'develop',
      repos: [
        { name: 'repo-a', monitor: true },
        { name: 'repo-b', monitor: true },
      ],
    };

    // Primary path doesn't match any configured repo
    const result = resolveSiblingWorkdirs(config, join(tmpBase, 'nonexistent'), tmpBase);
    expect(result).toEqual({});
  });

  it('uses custom basePath override', () => {
    const customBase = mkdtempSync(join(tmpdir(), 'repos-custom-'));
    try {
      mkdirSync(join(customBase, 'primary'));
      mkdirSync(join(customBase, 'sibling'));

      const config: WorkspaceConfig = {
        org: 'test-org',
        branch: 'develop',
        repos: [
          { name: 'primary', monitor: true },
          { name: 'sibling', monitor: true },
        ],
      };

      const result = resolveSiblingWorkdirs(config, join(customBase, 'primary'), customBase);
      expect(result).toHaveProperty('sibling');
      expect(result['sibling']).toContain('sibling');
    } finally {
      rmSync(customBase, { recursive: true, force: true });
    }
  });

  it('resolves symlinks via realpathSync fallback', () => {
    mkdirSync(join(tmpBase, 'real-primary'));
    mkdirSync(join(tmpBase, 'real-sibling'));
    symlinkSync(join(tmpBase, 'real-primary'), join(tmpBase, 'primary-link'));

    const config: WorkspaceConfig = {
      org: 'test-org',
      branch: 'develop',
      repos: [
        { name: 'real-primary', monitor: true },
        { name: 'real-sibling', monitor: true },
      ],
    };

    // Pass the symlink path as primary — should resolve to the real path and match
    const result = resolveSiblingWorkdirs(config, join(tmpBase, 'primary-link'), tmpBase);
    expect(result).toHaveProperty('real-sibling');
    expect(result).not.toHaveProperty('real-primary');
  });

  it('derives basePath from dirname of primaryWorkdir when not provided', () => {
    mkdirSync(join(tmpBase, 'primary'));
    mkdirSync(join(tmpBase, 'sibling'));

    const config: WorkspaceConfig = {
      org: 'test-org',
      branch: 'develop',
      repos: [
        { name: 'primary', monitor: true },
        { name: 'sibling', monitor: true },
      ],
    };

    // Don't pass basePath — should derive from dirname(primaryWorkdir)
    const result = resolveSiblingWorkdirs(config, join(tmpBase, 'primary'));
    expect(result).toHaveProperty('sibling');
  });
});
