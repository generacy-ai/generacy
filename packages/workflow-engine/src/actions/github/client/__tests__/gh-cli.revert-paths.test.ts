/**
 * #1218 T004 — behavioral tests for GhCliGitHubClient.revertPaths (SC-001, client half).
 *
 * Real temp git repo (Layer-2 pattern from managed-file-disjointness.test.ts):
 * tracked-modified paths are restored to HEAD; untracked paths are deleted;
 * staged-new paths are unstaged then deleted; a mixed call handles both; an
 * empty call is a no-op.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GhCliGitHubClient } from '../gh-cli.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('GhCliGitHubClient.revertPaths (#1218)', () => {
  let repoDir: string;
  let client: GhCliGitHubClient;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'revert-paths-'));
    git(repoDir, ['init', '-q', '-b', 'main']);
    git(repoDir, ['config', 'user.email', 'test@test']);
    git(repoDir, ['config', 'user.name', 'test']);
    git(repoDir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repoDir, 'CLAUDE.md'), '# base CLAUDE.md\n');
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-q', '-m', 'base']);
    client = new GhCliGitHubClient(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('restores a tracked, modified path to HEAD content', async () => {
    writeFileSync(join(repoDir, 'CLAUDE.md'), '# bloated CLAUDE.md\n');

    await client.revertPaths(['CLAUDE.md']);

    expect(readFileSync(join(repoDir, 'CLAUDE.md'), 'utf8')).toBe('# base CLAUDE.md\n');
    expect(git(repoDir, ['status', '--porcelain'])).toBe('');
  });

  it('restores a tracked path even when its modification is staged', async () => {
    writeFileSync(join(repoDir, 'CLAUDE.md'), '# staged bloat\n');
    git(repoDir, ['add', 'CLAUDE.md']);

    await client.revertPaths(['CLAUDE.md']);

    expect(readFileSync(join(repoDir, 'CLAUDE.md'), 'utf8')).toBe('# base CLAUDE.md\n');
    expect(git(repoDir, ['status', '--porcelain'])).toBe('');
  });

  it('deletes an untracked path', async () => {
    writeFileSync(join(repoDir, 'AGENTS.md'), '# new untracked\n');

    await client.revertPaths(['AGENTS.md']);

    expect(existsSync(join(repoDir, 'AGENTS.md'))).toBe(false);
    expect(git(repoDir, ['status', '--porcelain'])).toBe('');
  });

  it('unstages then deletes a staged-new path (absent from HEAD)', async () => {
    writeFileSync(join(repoDir, 'GEMINI.md'), '# staged new\n');
    git(repoDir, ['add', 'GEMINI.md']);

    await client.revertPaths(['GEMINI.md']);

    expect(existsSync(join(repoDir, 'GEMINI.md'))).toBe(false);
    expect(git(repoDir, ['status', '--porcelain'])).toBe('');
  });

  it('handles a mixed call: tracked restored, untracked deleted', async () => {
    writeFileSync(join(repoDir, 'CLAUDE.md'), '# bloated\n');
    writeFileSync(join(repoDir, 'AGENTS.md'), '# untracked\n');

    await client.revertPaths(['CLAUDE.md', 'AGENTS.md']);

    expect(readFileSync(join(repoDir, 'CLAUDE.md'), 'utf8')).toBe('# base CLAUDE.md\n');
    expect(existsSync(join(repoDir, 'AGENTS.md'))).toBe(false);
    expect(git(repoDir, ['status', '--porcelain'])).toBe('');
  });

  it('is a no-op on an empty array (does not touch the tree)', async () => {
    writeFileSync(join(repoDir, 'AGENTS.md'), '# untouched\n');

    await client.revertPaths([]);

    expect(existsSync(join(repoDir, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(repoDir, 'AGENTS.md'), 'utf8')).toBe('# untouched\n');
  });
});
