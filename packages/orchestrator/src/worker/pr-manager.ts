import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { WorkflowPhase, Logger } from './types.js';

/**
 * Manages draft PR creation and git commit/push operations between workflow phases.
 *
 * After each phase completes:
 * 1. Commits any changed files with a phase-specific message
 * 2. Pushes the branch to the remote
 * 3. Creates a draft PR (if one doesn't already exist)
 *
 * This ensures the PR is created early (after specify) and updated incrementally.
 */
export class PrManager {
  private prUrl: string | undefined;
  private prNumber: number | undefined;

  constructor(
    private readonly github: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly issueNumber: number,
    private readonly logger: Logger,
  ) {}

  /**
   * Get the current PR URL (if a PR has been created).
   */
  getPrUrl(): string | undefined {
    return this.prUrl;
  }

  /**
   * Commit any changes, push to remote, and ensure a draft PR exists.
   *
   * Safe to call after every phase — handles "nothing to commit" and
   * "PR already exists" gracefully.
   *
   * @returns An object with the PR URL (if available) and whether changes were produced
   * (either uncommitted changes we commit, or commits the phase made directly).
   */
  async commitPushAndEnsurePr(phase: WorkflowPhase): Promise<{ prUrl?: string; hasChanges: boolean }> {
    const hasChanges = await this.commitAndPush(phase);
    const prUrl = await this.ensureDraftPr();
    return { prUrl, hasChanges };
  }

  /**
   * Commit any uncommitted changes and push to the remote.
   *
   * Handles both cases: uncommitted changes (we commit them) and changes the
   * phase already committed directly (detected via unpushed commits).
   *
   * @returns true if changes were produced (committed or already committed), false otherwise.
   */
  private async commitAndPush(phase: WorkflowPhase): Promise<boolean> {
    try {
      let committed = false;

      // Check if there are any uncommitted changes to commit
      const status = await this.github.getStatus();
      if (status.has_changes) {
        // Stage all changes
        await this.github.stageAll();

        // Commit with a phase-specific message
        const message = `chore(speckit): complete ${phase} phase for #${this.issueNumber}`;
        const commitResult = await this.github.commit(message);
        this.logger.info(
          { phase, sha: commitResult.sha, files: commitResult.files_committed.length },
          'Committed phase changes',
        );
        committed = true;
      }

      // Check for unpushed commits (the phase may have committed directly)
      const branch = await this.github.getCurrentBranch();
      const remoteExists = await this.github.branchExists(branch, true).catch(() => false);
      let unpushedCount: number;
      if (remoteExists) {
        const unpushed = await this.github.getCommitsBetween(`origin/${branch}`, branch).catch(() => []);
        unpushedCount = unpushed.length;
      } else {
        // Remote branch doesn't exist yet — any local commits are unpushed
        const defaultBranch = await this.github.getDefaultBranch();
        const localCommits = await this.github.getCommitsBetween(`origin/${defaultBranch}`, branch).catch(() => []);
        unpushedCount = localCommits.length;
      }
      const hasUnpushed = unpushedCount > 0;

      if (!committed && !hasUnpushed) {
        this.logger.debug({ phase }, 'No changes to commit or push after phase');
        return false;
      }

      if (hasUnpushed) {
        if (!committed) {
          this.logger.info(
            { phase, unpushedCount },
            'Phase committed its own changes — pushing to remote',
          );
        }
        // Push to remote (set upstream on first push)
        const pushResult = await this.github.push('origin', branch, true);
        this.logger.info(
          { phase, ref: pushResult.ref, remote: pushResult.remote },
          'Pushed phase changes to remote',
        );
      }

      return true;
    } catch (error) {
      // Log but don't fail the workflow — commit/push is best-effort between phases
      this.logger.warn(
        { phase, error: String(error) },
        'Failed to commit/push after phase (non-fatal)',
      );
      return false;
    }
  }

  /**
   * Ensure a draft PR exists for the current branch.
   *
   * On first call: creates a new draft PR linked to the issue.
   * On subsequent calls: returns the existing PR URL (no-op).
   *
   * @returns The PR URL, or undefined if creation failed.
   */
  private async ensureDraftPr(): Promise<string | undefined> {
    // If we already know the PR URL, return it
    if (this.prUrl) {
      return this.prUrl;
    }

    try {
      const branch = await this.github.getCurrentBranch();

      // Check if a PR already exists for this branch
      const existingPr = await this.github.findPRForBranch(this.owner, this.repo, branch);
      if (existingPr) {
        this.prNumber = existingPr.number;
        this.prUrl = `https://github.com/${this.owner}/${this.repo}/pull/${existingPr.number}`;

        this.logger.info(
          { prNumber: existingPr.number, prUrl: this.prUrl },
          'Found existing PR for branch',
        );
        return this.prUrl;
      }

      // Create a new draft PR
      const defaultBranch = await this.github.getDefaultBranch();
      const pr = await this.github.createPullRequest(this.owner, this.repo, {
        title: `feat: #${this.issueNumber} ${branch}`,
        body: `## Summary\n\nCloses #${this.issueNumber}\n\n---\n*Draft PR created by Generacy orchestrator. Updated after each workflow phase.*\n`,
        head: branch,
        base: defaultBranch,
        draft: true,
      });

      this.prNumber = pr.number;
      this.prUrl = `https://github.com/${this.owner}/${this.repo}/pull/${pr.number}`;
      this.logger.info(
        { prNumber: pr.number, prUrl: this.prUrl },
        'Created draft PR',
      );

      return this.prUrl;
    } catch (error) {
      // Log but don't fail the workflow — PR creation is best-effort
      this.logger.warn(
        { error: String(error) },
        'Failed to ensure draft PR (non-fatal)',
      );
      return undefined;
    }
  }

  /**
   * Mark the draft PR as ready for review.
   *
   * Should be called after the workflow completes successfully (all phases done).
   * If no PR exists or the PR number is unknown, this is a no-op.
   *
   * The underlying GitHub API call is idempotent — calling it on a non-draft PR
   * has no effect.
   */
  async markReadyForReview(): Promise<void> {
    if (!this.prNumber) {
      this.logger.debug('No PR number available — skipping markReadyForReview');
      return;
    }

    try {
      await this.github.markPRReady(this.owner, this.repo, this.prNumber);
      this.logger.info(
        { prNumber: this.prNumber, prUrl: this.prUrl },
        'Marked PR as ready for review',
      );
    } catch (error) {
      // Log but don't fail the workflow — marking ready is best-effort
      this.logger.warn(
        { prNumber: this.prNumber, error: String(error) },
        'Failed to mark PR as ready for review (non-fatal)',
      );
    }
  }
}
