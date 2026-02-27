import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseRepoUrl,
  toShorthand,
  toConfigFormat,
  normalizeRepoUrl,
  detectPrimaryRepo,
  detectGitRoot,
  type ParsedRepo,
} from '../repo-utils.js';

// ---------------------------------------------------------------------------
// Mock execSafe — used by detectPrimaryRepo and detectGitRoot
// ---------------------------------------------------------------------------

vi.mock('../../../utils/exec.js', () => ({
  execSafe: vi.fn(),
}));

// Import the mocked module so we can control return values per-test
import { execSafe } from '../../../utils/exec.js';
const mockExecSafe = vi.mocked(execSafe);

// ---------------------------------------------------------------------------
// parseRepoUrl
// ---------------------------------------------------------------------------

describe('parseRepoUrl', () => {
  it('parses owner/repo shorthand', () => {
    expect(parseRepoUrl('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses shorthand with dots, hyphens, and underscores', () => {
    expect(parseRepoUrl('my-org/my_repo.js')).toEqual({
      owner: 'my-org',
      repo: 'my_repo.js',
    });
  });

  it('parses github.com/owner/repo (bare domain)', () => {
    expect(parseRepoUrl('github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses github.com/owner/repo.git (bare domain with .git)', () => {
    expect(parseRepoUrl('github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses https://github.com/owner/repo', () => {
    expect(parseRepoUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses https://github.com/owner/repo.git', () => {
    expect(parseRepoUrl('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses http://github.com/owner/repo', () => {
    expect(parseRepoUrl('http://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses git@github.com:owner/repo.git (SSH)', () => {
    expect(parseRepoUrl('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses git@github.com:owner/repo (SSH without .git)', () => {
    expect(parseRepoUrl('git@github.com:owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('trims whitespace from input', () => {
    expect(parseRepoUrl('  owner/repo  ')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('trims newlines (as from git command output)', () => {
    expect(parseRepoUrl('https://github.com/acme/app.git\n')).toEqual({
      owner: 'acme',
      repo: 'app',
    });
  });

  it('throws for empty string', () => {
    expect(() => parseRepoUrl('')).toThrow('Repository URL cannot be empty');
  });

  it('throws for whitespace-only string', () => {
    expect(() => parseRepoUrl('   ')).toThrow('Repository URL cannot be empty');
  });

  it('throws for unrecognized format', () => {
    expect(() => parseRepoUrl('not-valid')).toThrow('Unrecognized repository format');
  });

  it('throws for URL with extra path segments', () => {
    expect(() => parseRepoUrl('https://github.com/owner/repo/extra')).toThrow(
      'Unrecognized repository format',
    );
  });

  it('throws for non-GitHub host', () => {
    expect(() => parseRepoUrl('https://gitlab.com/owner/repo')).toThrow(
      'Unrecognized repository format',
    );
  });

  it('error message includes the invalid input', () => {
    expect(() => parseRepoUrl('garbage')).toThrow('"garbage"');
  });

  it('error message lists expected formats', () => {
    expect(() => parseRepoUrl('garbage')).toThrow('owner/repo');
  });
});

// ---------------------------------------------------------------------------
// toShorthand
// ---------------------------------------------------------------------------

describe('toShorthand', () => {
  it('returns owner/repo format', () => {
    expect(toShorthand({ owner: 'acme', repo: 'app' })).toBe('acme/app');
  });

  it('preserves casing and special characters', () => {
    expect(toShorthand({ owner: 'My-Org', repo: 'my_repo.js' })).toBe('My-Org/my_repo.js');
  });
});

// ---------------------------------------------------------------------------
// toConfigFormat
// ---------------------------------------------------------------------------

describe('toConfigFormat', () => {
  it('returns github.com/owner/repo format', () => {
    expect(toConfigFormat({ owner: 'acme', repo: 'app' })).toBe('github.com/acme/app');
  });

  it('preserves casing and special characters', () => {
    expect(toConfigFormat({ owner: 'My-Org', repo: 'my_repo.js' })).toBe(
      'github.com/My-Org/my_repo.js',
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeRepoUrl
// ---------------------------------------------------------------------------

describe('normalizeRepoUrl', () => {
  it('returns both shorthand and configFormat for shorthand input', () => {
    expect(normalizeRepoUrl('acme/app')).toEqual({
      shorthand: 'acme/app',
      configFormat: 'github.com/acme/app',
    });
  });

  it('normalizes HTTPS URL to both formats', () => {
    expect(normalizeRepoUrl('https://github.com/acme/app.git')).toEqual({
      shorthand: 'acme/app',
      configFormat: 'github.com/acme/app',
    });
  });

  it('normalizes SSH URL to both formats', () => {
    expect(normalizeRepoUrl('git@github.com:acme/app.git')).toEqual({
      shorthand: 'acme/app',
      configFormat: 'github.com/acme/app',
    });
  });

  it('normalizes bare domain URL to both formats', () => {
    expect(normalizeRepoUrl('github.com/acme/app')).toEqual({
      shorthand: 'acme/app',
      configFormat: 'github.com/acme/app',
    });
  });

  it('throws for invalid input', () => {
    expect(() => normalizeRepoUrl('invalid')).toThrow('Unrecognized repository format');
  });
});

// ---------------------------------------------------------------------------
// detectGitRoot
// ---------------------------------------------------------------------------

describe('detectGitRoot', () => {
  beforeEach(() => {
    mockExecSafe.mockReset();
  });

  it('returns the git root path when inside a repo', () => {
    mockExecSafe.mockReturnValue({
      ok: true,
      stdout: '/home/user/projects/my-app',
      stderr: '',
    });

    expect(detectGitRoot('/home/user/projects/my-app/src')).toBe(
      '/home/user/projects/my-app',
    );
    expect(mockExecSafe).toHaveBeenCalledWith('git rev-parse --show-toplevel', {
      cwd: '/home/user/projects/my-app/src',
    });
  });

  it('returns null when not inside a git repo', () => {
    mockExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });

    expect(detectGitRoot('/tmp/not-a-repo')).toBeNull();
  });

  it('returns null when stdout is empty', () => {
    mockExecSafe.mockReturnValue({
      ok: true,
      stdout: '',
      stderr: '',
    });

    expect(detectGitRoot('/some/path')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectPrimaryRepo
// ---------------------------------------------------------------------------

describe('detectPrimaryRepo', () => {
  beforeEach(() => {
    mockExecSafe.mockReset();
  });

  it('detects repo from HTTPS remote URL', () => {
    mockExecSafe.mockReturnValue({
      ok: true,
      stdout: 'https://github.com/acme/app.git',
      stderr: '',
    });

    expect(detectPrimaryRepo('/home/user/project')).toBe('acme/app');
    expect(mockExecSafe).toHaveBeenCalledWith('git remote get-url origin', {
      cwd: '/home/user/project',
    });
  });

  it('detects repo from SSH remote URL', () => {
    mockExecSafe.mockReturnValue({
      ok: true,
      stdout: 'git@github.com:acme/app.git',
      stderr: '',
    });

    expect(detectPrimaryRepo('/home/user/project')).toBe('acme/app');
  });

  it('detects repo from bare domain remote URL', () => {
    mockExecSafe.mockReturnValue({
      ok: true,
      stdout: 'github.com/acme/app',
      stderr: '',
    });

    expect(detectPrimaryRepo('/home/user/project')).toBe('acme/app');
  });

  it('returns null when no origin remote exists', () => {
    mockExecSafe.mockReturnValue({
      ok: false,
      stdout: '',
      stderr: "fatal: No such remote 'origin'",
    });

    expect(detectPrimaryRepo('/home/user/project')).toBeNull();
  });

  it('returns null when stdout is empty', () => {
    mockExecSafe.mockReturnValue({
      ok: true,
      stdout: '',
      stderr: '',
    });

    expect(detectPrimaryRepo('/home/user/project')).toBeNull();
  });

  it('returns null when remote URL is unparseable', () => {
    mockExecSafe.mockReturnValue({
      ok: true,
      stdout: 'https://gitlab.com/some/other-host-repo',
      stderr: '',
    });

    expect(detectPrimaryRepo('/home/user/project')).toBeNull();
  });
});
