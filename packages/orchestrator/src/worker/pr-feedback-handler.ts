import { createGitHubClient } from '@generacy-ai/workflow-engine';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { QueueItem, PrFeedbackMetadata } from '../types/index.js';
import type { Logger } from './types.js';
import type { WorkerConfig } from './config.js';
import type { SSEEventEmitter } from './output-capture.js';
import type { AgentLauncher } from '../launcher/agent-launcher.js';
import type { PrFeedbackIntent } from '@generacy-ai/generacy-plugin-claude-code';
import { OutputCapture } from './output-capture.js';
import { RepoCheckout } from './repo-checkout.js';

/**
 * Handles the `address-pr-feedback` command.
 *
 * Processing flow:
 *  1. Extract PR number from queue item metadata
 *  2. Fetch the PR to get the branch name
 *  3. Switch to the PR branch (not default branch)
 *  4. Fetch fresh unresolved review threads
 *  5. Build a structured prompt with all unresolved comments
 *  6. Spawn Claude CLI to address the feedback
 *  7. Stage, commit, and push changes to the PR branch
 *  8. Reply to each review thread (never resolve)
 *  9. Remove the `waiting-for:address-pr-feedback` label
 *
 * Error handling strategy (T019):
 *
 * **FR-013: Timeout handling**
 * - If CLI times out: push any partial changes that were made
 * - Keep `waiting-for:address-pr-feedback` label (don't remove)
 * - Label retention ensures the task will be retried on next detection cycle
 * - Log timeout warning with structured context
 *
 * **FR-007: Reply failure handling**
 * - If posting replies fails for some threads: still remove label
 * - Log warnings for each failed reply
 * - Partial reply success is acceptable (code changes were pushed successfully)
 * - Handler does not throw on reply failures
 *
 * **SC-006: Thread resolution prevention**
 * - Only use `replyToPRComment()` API — never call any thread-resolve API
 * - Human reviewer will resolve threads after verifying changes
 * - Comments in code explicitly reference SC-006 for clarity
 *
 * **Structured logging**
 * - All operations logged with structured context (prNumber, issueNumber, owner, repo)
 * - Error logs include full error messages and relevant context
 * - Success/failure states clearly logged for observability
 * - All FR/SC references included in log messages for traceability
 *
 * **Critical operation failures**
 * - PR fetch failure: throw (cannot proceed without PR details)
 * - Branch switch failure: throw (wrong branch would cause issues)
 * - Comment fetch failure: throw (cannot address unknown feedback)
 * - Push failure: log error but don't throw (allows retry via label)
 *
 * **Non-critical operation failures**
 * - No unresolved threads: remove label, early return (success case)
 * - Reply posting: log warning, continue (FR-007)
 * - Label removal: log warning, continue (non-fatal)
 */
export class PrFeedbackHandler {
  private readonly repoCheckout: RepoCheckout;

  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
    private readonly agentLauncher: AgentLauncher,
    private readonly sseEmitter?: SSEEventEmitter,
  ) {
    this.repoCheckout = new RepoCheckout(config.workspaceDir, logger);
  }

  /**
   * Process a PR feedback addressing task.
   *
   * @param item - Queue item with `command: 'address-pr-feedback'`
   * @param checkoutPath - Path to the already-checked-out repository
   */
  async handle(item: QueueItem, checkoutPath: string): Promise<void> {
    const { owner, repo, issueNumber } = item;
    const metadata = item.metadata as PrFeedbackMetadata | undefined;

    if (!metadata?.prNumber) {
      throw new Error('Missing prNumber in metadata for address-pr-feedback command');
    }

    const { prNumber } = metadata;
    const workflowId = `${owner}/${repo}#${issueNumber}`;

    this.logger.info(
      { prNumber, issueNumber, owner, repo },
      'Starting PR feedback addressing',
    );

    // Create GitHub client scoped to checkout path
    const github = createGitHubClient(checkoutPath);

    try {
      // 1. Fetch the PR to get branch name
      let pr;
      try {
        pr = await github.getPullRequest(owner, repo, prNumber);
      } catch (error) {
        this.logger.error(
          { error: String(error), prNumber, owner, repo },
          'Failed to fetch PR details',
        );
        throw new Error(`Failed to fetch PR #${prNumber}: ${String(error)}`);
      }

      const branchName = pr.head.ref;
      this.logger.info({ prNumber, branchName }, 'PR branch identified');

      // 2. Switch to the PR branch
      try {
        await this.repoCheckout.switchBranch(checkoutPath, branchName);
      } catch (error) {
        this.logger.error(
          { error: String(error), prNumber, branchName, checkoutPath },
          'Failed to switch to PR branch',
        );
        throw new Error(`Failed to switch to branch ${branchName}: ${String(error)}`);
      }

      // 3. Fetch fresh unresolved review threads
      let allComments;
      let unresolvedComments;
      try {
        allComments = await github.getPRComments(owner, repo, prNumber);
        unresolvedComments = allComments.filter((c) => c.resolved === false);

        this.logger.info(
          { prNumber, totalComments: allComments.length, unresolved: unresolvedComments.length },
          'Fetched PR review comments',
        );
      } catch (error) {
        this.logger.error(
          { error: String(error), prNumber, owner, repo },
          'Failed to fetch PR review comments',
        );
        throw new Error(`Failed to fetch review comments for PR #${prNumber}: ${String(error)}`);
      }

      // 4. If no unresolved threads, remove label and return early
      if (unresolvedComments.length === 0) {
        this.logger.info(
          { prNumber, issueNumber },
          'No unresolved threads found — removing label and exiting',
        );
        await this.removeFeedbackLabel(github, owner, repo, issueNumber);
        return;
      }

      // 5. Build structured prompt
      const prompt = this.buildFeedbackPrompt(unresolvedComments, prNumber, issueNumber);

      // 6. Spawn Claude CLI to address feedback
      const success = await this.spawnClaudeForFeedback(
        checkoutPath,
        prompt,
        workflowId,
        prNumber,
      );

      // 7. Commit and push changes (even on timeout — partial completion strategy)
      // FR-013: Push partial changes on timeout to preserve work and enable retry
      let hasChanges = false;
      try {
        hasChanges = await this.commitAndPushChanges(
          github,
          checkoutPath,
          branchName,
          prNumber,
          issueNumber,
        );

        if (hasChanges) {
          this.logger.info(
            { prNumber, issueNumber, success },
            'Successfully pushed changes to PR branch',
          );
        }
      } catch (error) {
        this.logger.error(
          { error: String(error), prNumber, issueNumber, branchName },
          'Failed to commit and push changes — partial work may be lost',
        );
        // Don't throw here — we want to continue with reply attempt and label management
        // The label will be kept for retry if success=false
      }

      if (!hasChanges && !success) {
        this.logger.warn(
          { prNumber, issueNumber },
          'No changes made and CLI did not complete successfully — will retry',
        );
      }

      // 8. Reply to review threads (only if CLI completed successfully)
      // FR-007: Partial reply failure is acceptable — we still remove the label
      if (success) {
        try {
          await this.replyToThreads(github, owner, repo, prNumber, unresolvedComments);
        } catch (error) {
          // FR-007: Even if reply posting fails, we consider the task complete
          // and remove the label. The code changes were pushed successfully.
          this.logger.warn(
            { error: String(error), prNumber, issueNumber },
            'Failed to post some or all thread replies — partial success acceptable',
          );
          // Continue to label removal
        }
      } else {
        this.logger.warn(
          { prNumber, issueNumber },
          'Skipping thread replies due to CLI timeout or failure — will retry on next cycle',
        );
      }

      // 9. Remove label (only if successful, otherwise keep for retry)
      // FR-013: Keep label on timeout/failure to enable retry
      if (success) {
        await this.removeFeedbackLabel(github, owner, repo, issueNumber);
        this.logger.info(
          { prNumber, issueNumber },
          'PR feedback addressing completed successfully',
        );
      } else {
        this.logger.info(
          { prNumber, issueNumber, hasChanges },
          'Keeping waiting-for:address-pr-feedback label for retry (CLI did not complete successfully)',
        );
      }
    } catch (error) {
      this.logger.error(
        { error: String(error), prNumber, issueNumber, owner, repo },
        'Error processing PR feedback — task failed',
      );
      throw error;
    }
  }

  /**
   * Build a structured prompt containing all unresolved review comments.
   *
   * The prompt instructs Claude to:
   * - Read each review comment
   * - Make the necessary code changes
   * - Commit the changes
   * - NOT resolve any threads (human reviewer will resolve)
   */
  private buildFeedbackPrompt(
    comments: Array<{ id: number; path?: string; line?: number; body: string; author: string }>,
    prNumber: number,
    issueNumber: number,
  ): string {
    const commentList = comments
      .map((c, idx) => {
        const location = c.path && c.line
          ? `${c.path}:${c.line}`
          : c.path || 'general comment';
        return `${idx + 1}. **${c.author}** (${location}):\n   ${c.body}`;
      })
      .join('\n\n');

    return `You are addressing PR review feedback for PR #${prNumber} (linked to issue #${issueNumber}).

The following unresolved review comments need to be addressed:

${commentList}

**Instructions:**
1. Read and understand each review comment above
2. Make the necessary code changes to address each comment
3. The changes will be automatically committed and pushed to the PR branch
4. Do NOT resolve any review threads — the human reviewer will resolve them after verifying your changes

Please proceed with addressing the feedback.`;
  }

  /**
   * Spawn Claude CLI to address PR feedback.
   *
   * Returns true if the CLI completed successfully, false on timeout or failure.
   * FR-013: On timeout, partial changes are pushed and label is kept for retry.
   */
  private async spawnClaudeForFeedback(
    checkoutPath: string,
    prompt: string,
    workflowId: string,
    prNumber: number,
  ): Promise<boolean> {
    this.logger.info(
      { cwd: checkoutPath, timeoutMs: this.config.phaseTimeoutMs },
      'Spawning Claude CLI for PR feedback',
    );

    let child;
    try {
      const handle = this.agentLauncher.launch({
        intent: {
          kind: 'pr-feedback',
          prNumber,
          prompt,
        } as PrFeedbackIntent,
        cwd: checkoutPath,
        env: {},
      });
      child = handle.process;
    } catch (error) {
      this.logger.error(
        { error: String(error), cwd: checkoutPath },
        'Failed to spawn Claude CLI process',
      );
      return false;
    }

    // Set up output capture for SSE events
    const outputCapture = new OutputCapture(workflowId, this.logger, this.sseEmitter);

    // Capture stdout
    if (child.stdout) {
      child.stdout.on('data', (data: Buffer | string) => {
        outputCapture.processChunk(typeof data === 'string' ? data : data.toString('utf-8'));
      });
    }

    // Capture stderr for error diagnostics
    if (child.stderr) {
      let stderrBuffer = '';
      child.stderr.on('data', (data: Buffer | string) => {
        stderrBuffer += typeof data === 'string' ? data : data.toString('utf-8');
      });

      // Log stderr on process exit if non-empty
      child.exitPromise.finally(() => {
        if (stderrBuffer.trim()) {
          this.logger.debug(
            { stderr: stderrBuffer.trim() },
            'Claude CLI stderr output',
          );
        }
      });
    }

    // Set up timeout
    // FR-013: On timeout, we return false and the caller will push partial changes
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      this.logger.warn(
        { pid: child.pid, timeoutMs: this.config.phaseTimeoutMs },
        'PR feedback CLI timed out (FR-013) — sending SIGTERM, partial changes will be pushed',
      );
      child.kill('SIGTERM');

      // Force kill after grace period
      setTimeout(() => {
        if (child.pid) {
          this.logger.warn(
            { pid: child.pid, gracePeriodMs: this.config.shutdownGracePeriodMs },
            'Grace period expired, sending SIGKILL',
          );
          child.kill('SIGKILL');
        }
      }, this.config.shutdownGracePeriodMs);
    }, this.config.phaseTimeoutMs);

    try {
      const exitCode = await child.exitPromise;
      clearTimeout(timeoutTimer);
      outputCapture.flush();

      const success = exitCode === 0;

      if (timedOut) {
        // FR-013: Timeout scenario — partial completion strategy
        this.logger.warn(
          { exitCode, timeoutMs: this.config.phaseTimeoutMs },
          'CLI timed out — returning false to trigger partial completion strategy (push changes, keep label)',
        );
        return false;
      }

      if (!success) {
        this.logger.warn(
          { exitCode },
          'CLI exited with non-zero code — returning false to keep label for retry',
        );
      } else {
        this.logger.info(
          { exitCode },
          'CLI completed successfully',
        );
      }

      return success;
    } catch (error) {
      clearTimeout(timeoutTimer);
      this.logger.error(
        { error: String(error), timedOut },
        'Error waiting for CLI process — returning false',
      );
      return false;
    }
  }

  /**
   * Stage all changes, commit, and push to the PR branch.
   *
   * Returns true if there were changes to commit, false otherwise.
   */
  private async commitAndPushChanges(
    github: GitHubClient,
    checkoutPath: string,
    branchName: string,
    prNumber: number,
    issueNumber: number,
  ): Promise<boolean> {
    let status;
    try {
      status = await github.getStatus();
    } catch (error) {
      this.logger.error(
        { error: String(error), checkoutPath },
        'Failed to get git status',
      );
      throw new Error(`Failed to get git status: ${String(error)}`);
    }

    if (!status.has_changes) {
      this.logger.info(
        { prNumber, issueNumber },
        'No changes to commit — skipping commit/push',
      );
      return false;
    }

    this.logger.info(
      { prNumber, staged: status.staged.length, unstaged: status.unstaged.length, untracked: status.untracked.length },
      'Staging and committing changes',
    );

    // Stage all changes
    try {
      await github.stageAll();
    } catch (error) {
      this.logger.error(
        { error: String(error), prNumber },
        'Failed to stage changes',
      );
      throw new Error(`Failed to stage changes: ${String(error)}`);
    }

    // Commit with clear message
    const commitMessage = `Address PR #${prNumber} review feedback

Automated feedback addressing for issue #${issueNumber}.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`;

    try {
      await github.commit(commitMessage);
    } catch (error) {
      this.logger.error(
        { error: String(error), prNumber },
        'Failed to commit changes',
      );
      throw new Error(`Failed to commit changes: ${String(error)}`);
    }

    // Push to PR branch
    this.logger.info({ prNumber, branch: branchName }, 'Pushing changes to PR branch');
    try {
      await github.push('origin', branchName);
    } catch (error) {
      this.logger.error(
        { error: String(error), prNumber, branch: branchName },
        'Failed to push changes to PR branch',
      );
      throw new Error(`Failed to push to branch ${branchName}: ${String(error)}`);
    }

    this.logger.info({ prNumber, branch: branchName }, 'Successfully pushed changes');
    return true;
  }

  /**
   * Post a reply to each unresolved review thread.
   *
   * SC-006: Never resolves threads — that's left to the human reviewer.
   * FR-007: Partial failure is acceptable: if some replies fail, log warnings but continue.
   *         The handler will still remove the label even if some replies fail.
   */
  private async replyToThreads(
    github: GitHubClient,
    owner: string,
    repo: string,
    prNumber: number,
    comments: Array<{ id: number; path?: string; line?: number; body: string }>,
  ): Promise<void> {
    this.logger.info(
      { prNumber, threadCount: comments.length },
      'Posting replies to review threads',
    );

    let successCount = 0;
    let failureCount = 0;

    for (const comment of comments) {
      try {
        // SC-006: Only reply, never resolve — human reviewer will resolve after verification
        const replyBody = `I've addressed this feedback in the latest commit. Please review the changes.`;

        await github.replyToPRComment(owner, repo, prNumber, comment.id, replyBody);

        this.logger.debug(
          { prNumber, commentId: comment.id, path: comment.path, line: comment.line },
          'Posted reply to review thread',
        );

        successCount++;
      } catch (error) {
        // FR-007: Continue processing other threads even if this one fails
        failureCount++;
        this.logger.warn(
          { error: String(error), prNumber, commentId: comment.id, path: comment.path, line: comment.line },
          'Failed to post reply to review thread — continuing with remaining threads',
        );
      }
    }

    if (failureCount > 0) {
      this.logger.warn(
        { prNumber, successCount, failureCount, total: comments.length },
        'Some thread replies failed — partial success (acceptable per FR-007)',
      );
    } else {
      this.logger.info(
        { prNumber, successCount, total: comments.length },
        'Successfully posted all thread replies',
      );
    }

    // FR-007: Even if all replies fail, we don't throw — the caller will still remove the label
    // because the code changes were pushed successfully
  }

  /**
   * Remove the `waiting-for:address-pr-feedback` label from the linked issue.
   */
  private async removeFeedbackLabel(
    github: GitHubClient,
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<void> {
    try {
      await github.removeLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback']);
      this.logger.info({ issueNumber }, 'Removed waiting-for:address-pr-feedback label');
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber },
        'Failed to remove waiting-for:address-pr-feedback label — non-fatal',
      );
    }
  }
}
