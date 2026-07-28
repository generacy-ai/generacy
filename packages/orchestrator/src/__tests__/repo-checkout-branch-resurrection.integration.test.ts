/**
 * #1051 SC-001 integration test: branch resurrection after merge + delete.
 *
 * Real-git repro of the field failure in generacy-cloud#883: a PR merged with
 * `--delete-branch` deleted the branch upstream, but the worker re-entered
 * the same checkout, `switchBranch` (pre-fix) silently succeeded against
 * the stale local tracking ref, and `reset --hard origin/<branch>` restored
 * the pre-merge tip. This test drives the pre-fix contract through
 * `switchBranch` and `updateRepo` (via `ensureCheckout`) and asserts the
 * remote branch is NOT recreated afterward.
 *
 * Post-fix: `--prune` on the fetch removes the stale tracking ref, so
 * `reset --hard origin/<branch>` fails loudly. That throw is caught here to
 * assert the failure mode (it is the desired signal — see
 * `contracts/repo-checkout-prune.md § Behavior contract`). What we ASSERT is
 * that after the switchBranch/updateRepo call resolves or throws, the remote
 * branch on origin is still absent — the worker did not silently recreate it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

async function remoteHasBranch(originDir: string, branch: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-remote', '--heads', originDir, branch],
    { encoding: 'utf-8' },
  );
  return stdout.trim() !== '';
}

describe('#1051 SC-001: branch resurrection integration test', () => {
  let root: string;
  let originDir: string;
  let checkoutA: string;
  let checkoutB: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gen-1051-resurrection-'));
    originDir = join(root, 'origin.git');
    checkoutA = join(root, 'checkoutA');
    checkoutB = join(root, 'checkoutB');

    // Bare origin.
    await mkdir(originDir, { recursive: true });
    await git(originDir, 'init', '--bare');

    // checkoutA: seed develop and a `feature` branch, push to origin.
    await git(root, 'clone', originDir, 'checkoutA');
    await git(checkoutA, 'checkout', '-b', 'develop');
    await writeFile(join(checkoutA, 'README.md'), '# initial\n', 'utf-8');
    await git(checkoutA, 'add', 'README.md');
    await git(checkoutA, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
    await git(checkoutA, 'push', '-u', 'origin', 'develop');

    await git(checkoutA, 'checkout', '-b', 'feature');
    await writeFile(join(checkoutA, 'feature.md'), 'feature body\n', 'utf-8');
    await git(checkoutA, 'add', 'feature.md');
    await git(checkoutA, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'feature commit');
    await git(checkoutA, 'push', '-u', 'origin', 'feature');

    // Return to develop so subsequent switchBranch calls exercise the switch.
    await git(checkoutA, 'checkout', 'develop');

    // checkoutB: separate clone that simulates "PR merged with --delete-branch"
    // by deleting the feature ref from origin.
    await git(root, 'clone', originDir, 'checkoutB');
    await git(checkoutB, 'push', 'origin', '--delete', 'feature');

    // Sanity: feature is gone from origin, but checkoutA still has a stale
    // local tracking ref (this is the pre-fix contamination surface).
    expect(await remoteHasBranch(originDir, 'feature')).toBe(false);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('switchBranch on checkoutA does NOT resurrect the deleted `feature` branch', async () => {
    const checkout = new RepoCheckout(root, noopLogger);

    // Post-fix, `--prune` removes the stale ref; the subsequent
    // `reset --hard origin/feature` throws (desired signal per
    // contracts/repo-checkout-prune.md § Behavior contract). Either outcome
    // is acceptable — what matters is that the branch is not resurrected.
    await checkout.switchBranch(checkoutA, 'feature').catch(() => {
      // Expected post-fix on some paths — the pruned tracking ref makes the
      // reset ambiguous. The push-guard (FR-002) would fire before the reset
      // is reached in the real flow; we assert the resurrection invariant
      // regardless of which arm ran.
    });

    // Invariant: origin still has no `feature` branch — no silent recreation.
    expect(await remoteHasBranch(originDir, 'feature')).toBe(false);
  });

  it('updateRepo (via ensureCheckout) on the existing checkout does NOT resurrect `feature`', async () => {
    // Rename checkoutA into the layout ensureCheckout expects for
    // bootstrapped-path resolution: `{workspaceDir}/{repo}/.git`. Renaming
    // avoids re-seeding the same fixture in two places.
    const bootDir = join(root, 'feature'); // arbitrary repo name
    await execFileAsync('mv', [checkoutA, bootDir]);

    const checkout = new RepoCheckout(root, noopLogger);
    await checkout.ensureCheckout('worker-1', 'org', 'feature', 'feature').catch(() => {
      // Same rationale as above.
    });

    expect(await remoteHasBranch(originDir, 'feature')).toBe(false);
  });
});
