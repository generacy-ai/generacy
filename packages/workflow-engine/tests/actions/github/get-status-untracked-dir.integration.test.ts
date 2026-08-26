/**
 * Real-git integration test for GhCliGitHubClient.getStatus (#1162).
 *
 * A wholly-untracked `.generacy/` directory must surface as one entry per file
 * (`.generacy/review-findings-x.json`, ...) rather than a collapsed `.generacy/`
 * directory entry, so path-prefix consumers (the orchestrator's engine-sidecar
 * staging filter) can see — and skip — each sidecar.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhCliGitHubClient } from '../../../src/actions/github/client/gh-cli.js';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, env: GIT_ENV });
}

describe('GhCliGitHubClient.getStatus — untracked directory expansion (real git)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'gh-cli-get-status-'));
    await git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'README.md'), 'hello\n');
    await git(repo, 'add', 'README.md');
    await git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('lists every file inside a wholly-untracked .generacy/ directory', async () => {
    await mkdir(join(repo, '.generacy'), { recursive: true });
    await writeFile(join(repo, '.generacy', 'review-findings-x.json'), '{}');
    await writeFile(join(repo, '.generacy', 'pause-context-x.json'), '{}');
    await writeFile(join(repo, 'new.ts'), 'export {};\n');
    await writeFile(join(repo, 'README.md'), 'edited\n');

    const status = await new GhCliGitHubClient(repo).getStatus();

    expect(status.branch).toBe('main');
    expect(status.has_changes).toBe(true);
    expect(status.untracked.sort()).toEqual([
      '.generacy/pause-context-x.json',
      '.generacy/review-findings-x.json',
      'new.ts',
    ]);
    expect(status.untracked).not.toContain('.generacy/');
    expect(status.unstaged).toEqual(['README.md']);
    expect(status.staged).toEqual([]);
  });
});
