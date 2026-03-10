import { mkdir, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import type { Logger } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Manages git repository checkouts for workers.
 *
 * Supports two modes:
 * - **Container-per-worker** (preferred): If a bootstrapped repo already exists
 *   at `{workspaceDir}/{repo}`, it is reused directly. This avoids redundant
 *   clones and ensures the checkout shares the same environment (MCP server
 *   paths, node_modules, build artifacts) set up by the bootstrap entrypoint.
 * - **Isolated checkout** (fallback): If no bootstrapped repo is found, a fresh
 *   clone is created at `{workspaceDir}/{workerId}/{owner}/{repo}` to isolate
 *   concurrent workers sharing a single process.
 */
export class RepoCheckout {
  constructor(
    private readonly workspaceDir: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Compute the checkout path for a given worker and repository.
   *
   * Prefers a bootstrapped repo at `{workspaceDir}/{repo}` when it exists.
   * Falls back to the isolated path `{workspaceDir}/{workerId}/{owner}/{repo}`.
   */
  async getCheckoutPath(workerId: string, owner: string, repo: string): Promise<string> {
    const bootstrappedPath = join(this.workspaceDir, repo);
    if (await this.directoryExists(join(bootstrappedPath, '.git'))) {
      this.logger.debug(
        { bootstrappedPath, repo },
        'Using bootstrapped repo checkout',
      );
      return bootstrappedPath;
    }
    return join(this.workspaceDir, workerId, owner, repo);
  }

  /**
   * Ensure a repository checkout exists and is up-to-date on the given branch.
   *
   * If the checkout directory does not exist, the repository is cloned.
   * If it already exists, it is fetched and reset to the remote branch head.
   *
   * @param workerId - Unique worker identifier
   * @param owner - Repository owner (GitHub user or org)
   * @param repo - Repository name
   * @param branch - Branch to check out
   * @returns The absolute path to the checkout directory
   */
  async ensureCheckout(
    workerId: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string> {
    const checkoutPath = await this.getCheckoutPath(workerId, owner, repo);

    const exists = await this.directoryExists(checkoutPath);

    if (!exists) {
      await this.cloneRepo(checkoutPath, owner, repo, branch);
    } else {
      await this.updateRepo(checkoutPath, branch);
    }

    return checkoutPath;
  }

  /**
   * Get the default branch for a repository using the GitHub API.
   */
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('gh', [
        'repo', 'view', `${owner}/${repo}`, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name',
      ]);
      const branch = stdout.trim();
      if (branch) {
        this.logger.info({ owner, repo, branch }, 'Resolved default branch');
        return branch;
      }
    } catch (error) {
      this.logger.warn(
        { err: error, owner, repo },
        'Failed to resolve default branch, falling back to develop',
      );
    }
    return 'develop';
  }

  /**
   * Switch an existing checkout to a different branch.
   * Fetches from origin first, then checks out the branch and resets to remote HEAD.
   */
  async switchBranch(checkoutPath: string, branch: string): Promise<void> {
    this.logger.info({ checkoutPath, branch }, 'Switching to branch');

    // Discard any leftover dirty state from previous worker runs
    await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: checkoutPath });
    await execFileAsync('git', ['clean', '-fd'], { cwd: checkoutPath });

    await execFileAsync('git', ['fetch', 'origin'], { cwd: checkoutPath });

    try {
      await execFileAsync('git', ['checkout', branch], { cwd: checkoutPath });
    } catch {
      this.logger.debug({ checkoutPath, branch }, 'Local branch not found, creating tracking branch');
      await execFileAsync('git', ['checkout', '-B', branch, `origin/${branch}`], {
        cwd: checkoutPath,
      });
    }

    await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], {
      cwd: checkoutPath,
    });

    this.logger.info({ checkoutPath, branch }, 'Switched to branch successfully');
  }

  /**
   * Remove a checkout directory recursively.
   *
   * @param checkoutPath - Absolute path to the checkout directory to remove
   */
  async cleanup(checkoutPath: string): Promise<void> {
    this.logger.info({ checkoutPath }, 'Cleaning up checkout directory');
    await rm(checkoutPath, { recursive: true, force: true });
    this.logger.debug({ checkoutPath }, 'Checkout directory removed');
  }

  /**
   * Check whether a directory exists on disk.
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      await stat(dirPath);
      return true;
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Clone a repository into the checkout path.
   */
  private async cloneRepo(
    checkoutPath: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<void> {
    const parentDir = dirname(checkoutPath);
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    this.logger.info(
      { checkoutPath, repoUrl, branch },
      'Cloning repository',
    );

    await mkdir(parentDir, { recursive: true });
    this.logger.debug({ parentDir }, 'Created parent directories');

    await execFileAsync('git', [
      'clone',
      '--branch', branch,
      repoUrl,
      checkoutPath,
    ]);

    this.logger.info(
      { checkoutPath, branch },
      'Repository cloned successfully',
    );
  }

  /**
   * Update an existing checkout to the latest state of a branch.
   */
  private async updateRepo(
    checkoutPath: string,
    branch: string,
  ): Promise<void> {
    this.logger.info(
      { checkoutPath, branch },
      'Updating existing checkout',
    );

    // Discard any leftover dirty state from previous worker runs
    this.logger.debug({ checkoutPath }, 'Discarding dirty state before branch switch');
    await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: checkoutPath });
    await execFileAsync('git', ['clean', '-fd'], { cwd: checkoutPath });

    this.logger.debug({ checkoutPath }, 'Fetching from origin');
    await execFileAsync('git', ['fetch', 'origin'], { cwd: checkoutPath });

    this.logger.debug({ checkoutPath, branch }, 'Checking out branch');
    try {
      await execFileAsync('git', ['checkout', branch], { cwd: checkoutPath });
    } catch {
      this.logger.debug(
        { checkoutPath, branch },
        'Local branch not found, creating tracking branch',
      );
      await execFileAsync('git', ['checkout', '-B', branch, `origin/${branch}`], {
        cwd: checkoutPath,
      });
    }

    this.logger.debug({ checkoutPath, branch }, 'Resetting to origin branch head');
    await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], {
      cwd: checkoutPath,
    });

    this.logger.info(
      { checkoutPath, branch },
      'Checkout updated successfully',
    );
  }
}
