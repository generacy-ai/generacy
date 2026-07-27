/**
 * #1051 SC-003 regression: cross-issue working-tree contamination.
 *
 * Bootstrapped-repo reuse is the mode in which one checkout serves multiple
 * issues in sequence. If issue B leaves files in the working tree and we then
 * enter the phase-commit path for issue A, `switchBranch` MUST reset the tree
 * so the resulting commit contains ONLY issue-A-scoped files.
 *
 * `switchBranch` (`repo-checkout.ts:106-107`) and `updateRepo` (`:220-221`)
 * both perform `git reset --hard HEAD` + `git clean -fd` before fetch. This
 * regression test exercises the invariant on a real ephemeral git repo. Per
 * `quickstart.md § Troubleshooting`: stage the issue-B files but do NOT
 * commit them — `git reset --hard HEAD` drops staged-but-uncommitted state,
 * which is exactly the contamination surface the field failure hit.
 *
 * No source changes for FR-004 — the existing hard-reset already provides
 * the invariant. This test is the regression guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoCheckout } from '../worker/repo-checkout.js';
import type { Logger } from '../worker/types.js';

const execFileAsync = promisify(execFile);

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() { return this; },
} as unknown as Logger;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' });
  return stdout;
}

async function initBareRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '--bare');
}

async function directoryExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('#1051 SC-003: cross-issue working-tree contamination regression', () => {
  let root: string;
  let originDir: string;
  let checkoutDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gen-1051-crossissue-'));
    originDir = join(root, 'origin.git');
    checkoutDir = join(root, 'checkout');

    await initBareRepo(originDir);

    // Initial commit on develop so branches have a base.
    await git(root, 'clone', originDir, checkoutDir);
    await git(checkoutDir, 'checkout', '-b', 'develop');
    await writeFile(join(checkoutDir, 'README.md'), '# initial\n', 'utf-8');
    await git(checkoutDir, 'add', 'README.md');
    await git(checkoutDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
    await git(checkoutDir, 'push', '-u', 'origin', 'develop');

    // Set up issue-A branch on remote — one committed file at HEAD.
    await git(checkoutDir, 'checkout', '-b', 'issue-A');
    await writeFile(join(checkoutDir, 'issue-a.md'), 'A body\n', 'utf-8');
    await git(checkoutDir, 'add', 'issue-a.md');
    await git(checkoutDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'a');
    await git(checkoutDir, 'push', '-u', 'origin', 'issue-A');

    // Return to develop so the reused checkout starts on develop.
    await git(checkoutDir, 'checkout', 'develop');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('switchBranch drops staged issue-B files before phase-commit for issue A (invariant regression guard)', async () => {
    // Simulate issue-B's residue: files staged in the current checkout but
    // NOT committed. This mirrors the field failure where the reused checkout
    // carried another issue's working tree into an issue-A phase run.
    await writeFile(join(checkoutDir, 'specs/B-something/spec.md'.replace('/', '/')), '', 'utf-8').catch(async () => {
      // Create the nested dir first if writeFile balked on missing parent.
      await mkdir(join(checkoutDir, 'specs', 'B-something'), { recursive: true });
      await writeFile(join(checkoutDir, 'specs', 'B-something', 'spec.md'), 'B body\n', 'utf-8');
    });
    await writeFile(join(checkoutDir, 'issue-b-extra.md'), 'B extra\n', 'utf-8');
    // Stage them (but do not commit) — quickstart § Troubleshooting.
    await git(checkoutDir, 'add', 'specs/B-something/spec.md', 'issue-b-extra.md');

    // Sanity: files exist and are staged.
    expect(await directoryExists(join(checkoutDir, 'specs', 'B-something'))).toBe(true);
    expect(await directoryExists(join(checkoutDir, 'issue-b-extra.md'))).toBe(true);

    // Now enter the phase for issue A via switchBranch — the hard-reset +
    // clean must drop the staged-but-uncommitted issue-B state.
    const checkout = new RepoCheckout(root, noopLogger);
    await checkout.switchBranch(checkoutDir, 'issue-A');

    // After switch, HEAD must be issue-A's tip — issue-a.md present, issue-B
    // files (both staged and untracked) must be gone. Neither the tracked
    // spec dir nor the loose issue-B file should survive the clean.
    expect(await directoryExists(join(checkoutDir, 'issue-a.md'))).toBe(true);
    expect(await directoryExists(join(checkoutDir, 'specs', 'B-something'))).toBe(false);
    expect(await directoryExists(join(checkoutDir, 'issue-b-extra.md'))).toBe(false);

    // Also: git status must be clean — no leftover residue that a subsequent
    // `git add -A` + commit would pick up onto issue-A's branch.
    const status = await git(checkoutDir, 'status', '--porcelain');
    expect(status.trim()).toBe('');
  });

  it('updateRepo (via ensureCheckout on an existing checkout) also drops staged residue', async () => {
    // Same residue pattern as the switchBranch case.
    await mkdir(join(checkoutDir, 'specs', 'B-something'), { recursive: true });
    await writeFile(join(checkoutDir, 'specs', 'B-something', 'spec.md'), 'B body\n', 'utf-8');
    await writeFile(join(checkoutDir, 'issue-b-extra.md'), 'B extra\n', 'utf-8');
    await git(checkoutDir, 'add', 'specs/B-something/spec.md', 'issue-b-extra.md');

    expect(await directoryExists(join(checkoutDir, 'specs', 'B-something'))).toBe(true);

    // ensureCheckout with an existing directory routes to updateRepo. We
    // point workspaceDir at `root` so bootstrapped-path resolution finds
    // `checkoutDir` (whose basename is 'checkout').
    const checkout = new RepoCheckout(root, noopLogger);
    await checkout.ensureCheckout('worker-1', 'org', 'checkout', 'issue-A');

    expect(await directoryExists(join(checkoutDir, 'issue-a.md'))).toBe(true);
    expect(await directoryExists(join(checkoutDir, 'specs', 'B-something'))).toBe(false);
    expect(await directoryExists(join(checkoutDir, 'issue-b-extra.md'))).toBe(false);

    const status = await git(checkoutDir, 'status', '--porcelain');
    expect(status.trim()).toBe('');
  });
});
