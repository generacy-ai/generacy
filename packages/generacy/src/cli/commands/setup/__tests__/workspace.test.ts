import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Mock modules before imports
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(() => '/tmp/test-home'),
  };
});

vi.mock('../../../utils/exec.js', () => ({
  exec: vi.fn(),
  execSafe: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
}));

vi.mock('../../../utils/logger.js', () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    getLogger: vi.fn(() => noopLogger),
  };
});

vi.mock('@generacy-ai/config', async () => {
  const actual = await vi.importActual<typeof import('@generacy-ai/config')>('@generacy-ai/config');
  return {
    ...actual,
    tryLoadWorkspaceConfig: vi.fn(() => null),
  };
});

import { existsSync } from 'node:fs';
import { execSafe } from '../../../utils/exec.js';
import { tryLoadWorkspaceConfig } from '@generacy-ai/config';
import { setupWorkspaceCommand } from '../workspace.js';

/**
 * Extract repo names from `git clone` calls recorded on the execSafe mock.
 */
function getClonedRepos(): string[] {
  const seen = new Set<string>();
  for (const call of (execSafe as Mock).mock.calls) {
    const cmd: string = call[0];
    if (!cmd.startsWith('git clone')) continue;
    const match = cmd.match(/\/([^/.]+)\.git/);
    if (match?.[1] && !seen.has(match[1])) {
      seen.add(match[1]);
    }
  }
  return [...seen];
}

/**
 * Extract the GitHub org used in `git clone` URLs.
 */
function getCloneOrg(): string | undefined {
  for (const call of (execSafe as Mock).mock.calls) {
    const cmd: string = call[0];
    if (!cmd.startsWith('git clone')) continue;
    const match = cmd.match(/github\.com\/([^/]+)\//);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * Extract the branch used in the first `git clone --branch` call.
 */
function getCloneBranch(): string | undefined {
  for (const call of (execSafe as Mock).mock.calls) {
    const cmd: string = call[0];
    if (!cmd.startsWith('git clone --branch')) continue;
    const match = cmd.match(/--branch\s+(\S+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

const ENV_KEYS = [
  'REPOS', 'REPO_BRANCH', 'DEFAULT_BRANCH', 'GITHUB_ORG',
  'CLEAN_REPOS', 'GH_TOKEN', 'GH_USERNAME',
] as const;

describe('workspace command override priority', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.clearAllMocks();

    (existsSync as Mock).mockReturnValue(false);
    (execSafe as Mock).mockReturnValue({ ok: true, stdout: '', stderr: '' });
    (tryLoadWorkspaceConfig as Mock).mockReturnValue(null);

    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    mockExit.mockRestore();
  });

  async function runCommand(args: string[] = []) {
    const command = setupWorkspaceCommand();
    await command.parseAsync(args, { from: 'user' });
  }

  // ── Priority tests ────────────────────────────────────────────────

  it('CLI --repos flag overrides REPOS env var and config file', async () => {
    // Set up env var with different repos
    process.env['REPOS'] = 'env-repo-a,env-repo-b';

    // Set up config file with yet another set of repos
    (tryLoadWorkspaceConfig as Mock).mockReturnValue({
      org: 'generacy-ai',
      branch: 'develop',
      repos: [
        { name: 'config-repo-x', monitor: true },
        { name: 'config-repo-y', monitor: true },
      ],
    });

    await runCommand(['--repos', 'cli-repo-1,cli-repo-2', '--workdir', '/tmp/ws']);

    const cloned = getClonedRepos();
    expect(cloned).toContain('cli-repo-1');
    expect(cloned).toContain('cli-repo-2');
    expect(cloned).not.toContain('env-repo-a');
    expect(cloned).not.toContain('env-repo-b');
    expect(cloned).not.toContain('config-repo-x');
    expect(cloned).not.toContain('config-repo-y');
  });

  it('REPOS env var overrides config file when no CLI flag', async () => {
    process.env['REPOS'] = 'env-repo-a,env-repo-b';

    // Config file has different repos
    (tryLoadWorkspaceConfig as Mock).mockReturnValue({
      org: 'generacy-ai',
      branch: 'develop',
      repos: [
        { name: 'config-repo-x', monitor: true },
        { name: 'config-repo-y', monitor: true },
      ],
    });

    await runCommand(['--workdir', '/tmp/ws']);

    const cloned = getClonedRepos();
    expect(cloned).toContain('env-repo-a');
    expect(cloned).toContain('env-repo-b');
    expect(cloned).not.toContain('config-repo-x');
    expect(cloned).not.toContain('config-repo-y');
  });

  it('config file is used when no CLI flag and no REPOS env var', async () => {
    (tryLoadWorkspaceConfig as Mock).mockReturnValue({
      org: 'generacy-ai',
      branch: 'develop',
      repos: [
        { name: 'config-repo-x', monitor: true },
        { name: 'config-repo-y', monitor: true },
      ],
    });

    await runCommand(['--workdir', '/tmp/ws']);

    const cloned = getClonedRepos();
    expect(cloned).toContain('config-repo-x');
    expect(cloned).toContain('config-repo-y');
  });

  it('bootstrap mode clones only tetrad-development when no config found and no overrides', async () => {
    // tryLoadWorkspaceConfig returns null (no config file)
    // No CLI flag, no env var
    (tryLoadWorkspaceConfig as Mock).mockReturnValue(null);

    await runCommand(['--workdir', '/tmp/ws']);

    const cloned = getClonedRepos();
    expect(cloned).toEqual(['tetrad-development']);
  });

  // ── Two-phase clone ───────────────────────────────────────────────

  it('two-phase clone: bootstraps tetrad-development, then clones additional repos from config', async () => {
    // First call (resolveWorkspaceConfig): no config → bootstrap
    // Second call (phase 2 in action handler): config found
    (tryLoadWorkspaceConfig as Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        org: 'generacy-ai',
        branch: 'develop',
        repos: [
          { name: 'tetrad-development', monitor: true },
          { name: 'generacy', monitor: true },
          { name: 'contracts', monitor: false },
        ],
      });

    await runCommand(['--workdir', '/tmp/ws']);

    const cloned = getClonedRepos();
    // tetrad-development is cloned in phase 1 (bootstrap)
    expect(cloned).toContain('tetrad-development');
    // additional repos from config are cloned in phase 2
    expect(cloned).toContain('generacy');
    expect(cloned).toContain('contracts');
    expect(cloned).toHaveLength(3);
  });

  it('two-phase clone does not re-clone tetrad-development in phase 2', async () => {
    (tryLoadWorkspaceConfig as Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        org: 'generacy-ai',
        branch: 'develop',
        repos: [
          { name: 'tetrad-development', monitor: true },
          { name: 'generacy', monitor: true },
        ],
      });

    await runCommand(['--workdir', '/tmp/ws']);

    // Count clone attempts for tetrad-development
    const tetradCloneCalls = (execSafe as Mock).mock.calls.filter(
      (call: string[]) => call[0].startsWith('git clone') && call[0].includes('tetrad-development'),
    );
    // Should be cloned exactly once (phase 1 only, filtered out in phase 2)
    expect(tetradCloneCalls.length).toBe(1);
  });

  // ── Config-derived defaults ───────────────────────────────────────

  it('config file provides org and branch as defaults', async () => {
    (tryLoadWorkspaceConfig as Mock).mockReturnValue({
      org: 'custom-org',
      branch: 'main',
      repos: [{ name: 'my-repo', monitor: true }],
    });

    await runCommand(['--workdir', '/tmp/ws']);

    expect(getCloneOrg()).toBe('custom-org');
    expect(getCloneBranch()).toBe('main');
  });

  it('CLI --branch overrides config branch', async () => {
    (tryLoadWorkspaceConfig as Mock).mockReturnValue({
      org: 'generacy-ai',
      branch: 'main',
      repos: [{ name: 'my-repo', monitor: true }],
    });

    await runCommand(['--workdir', '/tmp/ws', '--branch', 'feature/test']);

    expect(getCloneBranch()).toBe('feature/test');
  });

  it('GITHUB_ORG env var overrides config org', async () => {
    process.env['GITHUB_ORG'] = 'env-org';

    (tryLoadWorkspaceConfig as Mock).mockReturnValue({
      org: 'config-org',
      branch: 'develop',
      repos: [{ name: 'my-repo', monitor: true }],
    });

    await runCommand(['--workdir', '/tmp/ws']);

    expect(getCloneOrg()).toBe('env-org');
  });

  it('REPO_BRANCH env var overrides config branch', async () => {
    process.env['REPO_BRANCH'] = 'env-branch';

    (tryLoadWorkspaceConfig as Mock).mockReturnValue({
      org: 'generacy-ai',
      branch: 'config-branch',
      repos: [{ name: 'my-repo', monitor: true }],
    });

    await runCommand(['--workdir', '/tmp/ws']);

    expect(getCloneBranch()).toBe('env-branch');
  });

  // ── Bootstrap warning ─────────────────────────────────────────────

  it('bootstrap warns when no config found after cloning tetrad-development', async () => {
    // Both calls return null (no config exists even after clone)
    (tryLoadWorkspaceConfig as Mock).mockReturnValue(null);

    await runCommand(['--workdir', '/tmp/ws']);

    const cloned = getClonedRepos();
    expect(cloned).toEqual(['tetrad-development']);
    // Should not have cloned any additional repos
    expect(cloned).toHaveLength(1);
  });
});
