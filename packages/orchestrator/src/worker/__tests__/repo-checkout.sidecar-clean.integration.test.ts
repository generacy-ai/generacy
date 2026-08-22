/**
 * Integration test (real git): the cross-run checkout reset in
 * `RepoCheckout.switchBranch` / `updateRepo` must spare the engine's untracked
 * bookkeeping sidecars under `.generacy/` (#1162).
 *
 * `git clean -fd` with no exclusions wiped `.generacy/review-findings-*.json`
 * (and friends) on every re-entry — new run, address-pr-feedback, merge-conflict
 * re-arm — so the review round restarted at 1, `markedReadyByEngine` was lost,
 * and open findings + `lastReviewedCommitSha` were lost. Other untracked files
 * (including non-sidecar files under `.generacy/`) must still be cleaned, and
 * tracked-file edits must still be discarded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoCheckout } from '../repo-checkout.js';
import type { Logger } from '../types.js';

const execFileAsync = promisify(execFile);

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: GIT_ENV });
  return stdout;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('RepoCheckout sidecar-preserving clean (#1162, real git)', () => {
  let workspaceDir: string;
  let remoteDir: string;
  let checkoutPath: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'repo-checkout-sidecar-'));
    remoteDir = join(workspaceDir, 'remote.git');
    // `RepoCheckout.getCheckoutPath` prefers `{workspaceDir}/{repo}` when it has
    // a `.git` — that routes `ensureCheckout` through the private `updateRepo`.
    checkoutPath = join(workspaceDir, 'repo');

    // Seed the bare remote (main + feature) from a throwaway working repo, then
    // clone it the way the worker's bootstrapped checkout would be.
    const seedDir = join(workspaceDir, 'seed');
    await git(workspaceDir, 'init', '-q', '--bare', '-b', 'main', remoteDir);
    await git(workspaceDir, 'init', '-q', '-b', 'main', seedDir);
    await writeFile(join(seedDir, 'README.md'), 'hello\n');
    await git(seedDir, 'add', 'README.md');
    await git(seedDir, 'commit', '-q', '-m', 'init');
    await git(seedDir, 'branch', 'feature');
    await git(seedDir, 'remote', 'add', 'origin', remoteDir);
    await git(seedDir, 'push', '-q', 'origin', 'main', 'feature');
    await git(workspaceDir, 'clone', '-q', '--branch', 'main', remoteDir, checkoutPath);
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  /** Dirty the checkout the way a previous worker run leaves it. */
  async function dirtyCheckout(): Promise<void> {
    await mkdir(join(checkoutPath, '.generacy', 'epics'), { recursive: true });
    await writeFile(
      join(checkoutPath, '.generacy', 'review-findings-x.json'),
      JSON.stringify({ round: 3, markedReadyByEngine: true }),
    );
    await writeFile(join(checkoutPath, '.generacy', 'pause-context-x.json'), '{}');
    await writeFile(join(checkoutPath, '.generacy', 'workflow-state-x.json'), '{}');
    await writeFile(join(checkoutPath, '.generacy', 'epics', 'draft.md'), 'not a sidecar');
    await writeFile(join(checkoutPath, 'junk.txt'), 'leftover');
    await writeFile(join(checkoutPath, 'README.md'), 'dirty edit\n');
  }

  async function assertSidecarsSurvivedAndJunkCleaned(): Promise<void> {
    // Sidecars survive, content intact.
    const findings = await readFile(join(checkoutPath, '.generacy', 'review-findings-x.json'), 'utf-8');
    expect(JSON.parse(findings)).toEqual({ round: 3, markedReadyByEngine: true });
    expect(await exists(join(checkoutPath, '.generacy', 'pause-context-x.json'))).toBe(true);
    expect(await exists(join(checkoutPath, '.generacy', 'workflow-state-x.json'))).toBe(true);
    // Everything else untracked is cleaned — including non-sidecar files under .generacy/.
    expect(await exists(join(checkoutPath, 'junk.txt'))).toBe(false);
    expect(await exists(join(checkoutPath, '.generacy', 'epics', 'draft.md'))).toBe(false);
    // Tracked edits are still discarded.
    expect(await readFile(join(checkoutPath, 'README.md'), 'utf-8')).toBe('hello\n');
  }

  it('switchBranch keeps .generacy sidecars while cleaning other untracked files', async () => {
    await dirtyCheckout();
    const checkout = new RepoCheckout(workspaceDir, mockLogger);

    await checkout.switchBranch(checkoutPath, 'feature');

    expect((await git(checkoutPath, 'branch', '--show-current')).trim()).toBe('feature');
    await assertSidecarsSurvivedAndJunkCleaned();
  });

  it('ensureCheckout → updateRepo keeps .generacy sidecars while cleaning other untracked files', async () => {
    await dirtyCheckout();
    const checkout = new RepoCheckout(workspaceDir, mockLogger);

    const resolved = await checkout.ensureCheckout('worker-1', 'owner', 'repo', 'main');

    expect(resolved).toBe(checkoutPath);
    expect((await git(checkoutPath, 'branch', '--show-current')).trim()).toBe('main');
    await assertSidecarsSurvivedAndJunkCleaned();
  });
});
