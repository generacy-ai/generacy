/**
 * #1239 — behavioral integration test for the getStatus → stageFiles → commit
 * seam against a real temp git repo.
 *
 * Before the fix, `git status --porcelain` rendered a rename as a single
 * `old -> new` line and the parser staged that literal arrow string, so the
 * real paths never reached the commit and the rename was silently dropped.
 * This pins the real behavior: a renamed-and-modified file (`RM`) plus a plain
 * working-tree modification (` M`) round-trip through getStatus and land in the
 * commit as both source AND destination paths, leaving a clean tree.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
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

describe('GhCliGitHubClient rename round-trip (#1239)', () => {
  let repoDir: string;
  let client: GhCliGitHubClient;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'rename-status-'));
    git(repoDir, ['init', '-q', '-b', 'main']);
    git(repoDir, ['config', 'user.email', 'test@test']);
    git(repoDir, ['config', 'user.name', 'test']);
    git(repoDir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repoDir, 'old.ts'), 'export const x = 1;\n');
    writeFileSync(join(repoDir, 'other.ts'), 'export const y = 2;\n');
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-q', '-m', 'base']);
    client = new GhCliGitHubClient(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('stages and commits both source and destination of a rename, leaving a clean tree', async () => {
    // `git mv` stages the rename (index R); the append makes it `RM`.
    git(repoDir, ['mv', 'old.ts', 'new.ts']);
    appendFileSync(join(repoDir, 'new.ts'), 'export const z = 3;\n');
    // A plain working-tree modification yields a ` M` entry.
    appendFileSync(join(repoDir, 'other.ts'), 'export const w = 4;\n');

    const status = await client.getStatus();

    // Real paths only — no arrow artifact anywhere.
    for (const p of [...status.staged, ...status.unstaged, ...status.untracked]) {
      expect(p).not.toContain('->');
    }
    expect(status.staged).toContain('new.ts');
    expect(status.staged).toContain('old.ts');

    // Mirror commitAndPush's staging: dedup across the three lists.
    const toStage = [...new Set([...status.staged, ...status.unstaged, ...status.untracked])];
    await client.stageFiles(toStage);
    const result = await client.commit('rename round-trip', toStage);

    expect(result.files_committed).toContain('old.ts');
    expect(result.files_committed).toContain('new.ts');
    expect(result.files_committed).toContain('other.ts');
    expect(git(repoDir, ['status', '--porcelain'])).toBe('');
  });
});
