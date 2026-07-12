import {
  createGitHubClient,
  executeCommand,
  isTrustedCommentAuthor,
  tryLoadCommentTrustConfig,
  wrapUntrustedData,
} from '@generacy-ai/workflow-engine';
import type { Comment, GitHubClient, ReviewThread } from '@generacy-ai/workflow-engine';
import type { QueueItem, PrFeedbackMetadata } from '../types/index.js';
import type { Logger } from './types.js';
import type { WorkerConfig } from './config.js';
import type { SSEEventEmitter } from './output-capture.js';
import type { AgentLauncher } from '../launcher/agent-launcher.js';
import type { PrFeedbackIntent } from '@generacy-ai/generacy-plugin-claude-code';
import { OutputCapture } from './output-capture.js';
import { RepoCheckout } from './repo-checkout.js';
import { buildLaunchCredentials } from './credentials-helper.js';

/** Label added by the handler when the fix cycle cannot advance (#883). */
const BLOCKED_STUCK_FEEDBACK_LOOP_LABEL = 'blocked:stuck-feedback-loop';

/**
 * `agent:in-progress` label — cleared structurally at the single shared exit
 * path (#926 SC-004/SC-005). Extracted to a module constant so the literal
 * appears at exactly one code site: the coalesced happy-path removal and the
 * `clearInProgressLabel` fallback both reference this constant.
 */
const AGENT_IN_PROGRESS_LABEL = 'agent:in-progress';

/** Waiting gate cleared alongside `agent:in-progress` on the happy path. */
const WAITING_FOR_ADDRESS_PR_FEEDBACK_LABEL = 'waiting-for:address-pr-feedback';

type OutcomeResult = { ok: true } | { ok: false; error: string };

interface PerThreadOutcome {
  threadId: string;
  rootCommentId: number;
  replyResult: OutcomeResult;
  resolveResult: OutcomeResult;
}

/**
 * Handles the `address-pr-feedback` command.
 *
 * Processing flow:
 *  1. Extract PR number from queue item metadata
 *  2. Fetch the PR to get the branch name
 *  3. Switch to the PR branch (not default branch)
 *  4. Fetch fresh unresolved review threads (trust-filtered per-thread)
 *  5. Build a structured prompt with all trusted unresolved comments
 *  6. Spawn Claude CLI to address the feedback
 *  7. Commit + push. If CLI failed OR no diff → Disposition B (blocked)
 *  8. Otherwise: for each trusted unresolved thread — post one reply targeting
 *     the root comment, then call `resolveReviewThread(thread.id)`
 *  9. Strict-decrease success test — R = count of resolves that succeeded.
 *     R === 0 → Disposition B (blocked); R ≥ 1 → Disposition A (success):
 *     warn once per persistently-failed thread, then remove the
 *     `waiting-for:address-pr-feedback` label
 *
 * Disposition B (blocked, #883): add `blocked:stuck-feedback-loop` and leave
 * `waiting-for:address-pr-feedback` in place. The monitor's pre-enqueue
 * `blocked:*` check keeps the loop paused until an operator removes the
 * label. This ends the runaway "reply-only" cycle (5→10→20→…) observed on
 * christrudelpw/sniplink#4.
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

    // Create GitHub client scoped to checkout path. Hoisted above the try so
    // the `finally` clear can call it on every exit path (#926 SC-004).
    const github = createGitHubClient(checkoutPath);

    // #926 SC-004: `agent:in-progress` is cleared structurally at a single
    // shared exit path so no terminal return can leave the label pinned.
    // Idempotency-safe: happy path already coalesces the clear into its own
    // `removeLabels` call; this `finally` is a backstop for the four other
    // exit paths (Cases A/B, both blocked-stuck dispositions, and thrown
    // errors). Non-fatal on failure — mirrors `removeFeedbackLabel` shape.
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

      // 3. Fetch fresh unresolved review threads via GraphQL (#861).
      // REST never populated `.resolved`, so the old filter always emitted []
      // and the handler no-op'd. GraphQL exposes thread-level resolution.
      let allComments: Comment[];
      let unresolvedThreadCount: number;
      let unresolvedComments: Comment[];
      let trustedUnresolvedThreads: ReviewThread[];
      let untrustedSkips: Array<{
        commentId: number;
        author: string;
        authorAssociation: string | undefined;
        reason: string;
        viewerDidAuthor?: boolean;
      }>;
      try {
        const threads = await github.getPRReviewThreads(owner, repo, prNumber);
        const unresolvedThreads = threads.filter(t => !t.isResolved);
        allComments = threads.flatMap(t => t.comments);
        unresolvedThreadCount = unresolvedThreads.length;

        // Author-trust gating (#842, #869, #878). Log each skip and drop
        // untrusted comments before the CLI ever sees them. `pr-feedback`
        // surface honors widen-config from .agency/comment-trust.yaml. #878:
        // self-authorship comes from GraphQL's `viewerDidAuthor` field on
        // each comment, not a login-comparison rule threaded via context.
        //
        // #883: also track trusted-unresolved threads (not just comments) so
        // the post-CLI batch can iterate one-reply-per-thread and call
        // `resolveReviewThread` per thread.
        const trustConfig = tryLoadCommentTrustConfig(checkoutPath, this.logger);
        const botLogin = process.env['CLUSTER_GITHUB_USERNAME'] ?? process.env['GH_USERNAME'];
        const trustedUnresolved: Comment[] = [];
        const trustedThreads: ReviewThread[] = [];
        const skips: typeof untrustedSkips = [];
        for (const thread of unresolvedThreads) {
          let threadHasTrusted = false;
          for (const c of thread.comments) {
            const decision = isTrustedCommentAuthor(
              c,
              'pr-feedback',
              {
                logger: this.logger,
                ...(botLogin ? { botLogin } : {}),
                ...(trustConfig ? { config: trustConfig } : {}),
              },
            );
            if (decision.trusted) {
              trustedUnresolved.push(c);
              threadHasTrusted = true;
            } else {
              skips.push({
                commentId: c.id,
                author: c.author,
                authorAssociation: c.authorAssociation,
                reason: decision.reason,
                viewerDidAuthor: c.viewerDidAuthor,
              });
              this.logger.info(
                {
                  event: 'comment-skipped',
                  surface: 'pr-feedback',
                  commentId: c.id,
                  author: c.author,
                  authorAssociation: c.authorAssociation,
                  reason: decision.reason,
                  viewerDidAuthor: c.viewerDidAuthor ?? null,
                },
                'Skipped PR review comment from untrusted author',
              );
            }
          }
          if (threadHasTrusted) trustedThreads.push(thread);
        }

        unresolvedComments = trustedUnresolved;
        trustedUnresolvedThreads = trustedThreads;
        untrustedSkips = skips;

        this.logger.info(
          {
            prNumber,
            totalComments: allComments.length,
            unresolvedThreads: unresolvedThreads.length,
            trustedUnresolvedThreads: trustedThreads.length,
            trustedUnresolvedComments: trustedUnresolved.length,
          },
          'Fetched PR review threads (author-trust filtered)',
        );
      } catch (error) {
        this.logger.error(
          { error: String(error), prNumber, owner, repo },
          'Failed to fetch PR review threads',
        );
        throw new Error(`Failed to fetch review threads for PR #${prNumber}: ${String(error)}`);
      }

      // 4. Case A (#869): no unresolved threads at all — remove label and
      // clear dedupe key.
      if (unresolvedThreadCount === 0) {
        this.logger.info(
          { prNumber, issueNumber },
          'No unresolved threads found — removing label and exiting',
        );
        await this.removeFeedbackLabel(github, owner, repo, issueNumber);
        return;
      }

      // 4b. Case B (#869 / FR-002): unresolved threads exist, but every
      // comment is untrusted (race-window residue that the monitor didn't
      // catch, or degraded-identity mode). Retain the waiting-for label
      // (FR-002) and clear the dedupe key so the next monitor poll can
      // re-enqueue if the situation changes. Do NOT emit the "No unresolved
      // threads found" log line (SC-002).
      if (unresolvedComments.length === 0) {
        this.logger.warn(
          {
            prNumber, issueNumber, owner, repo,
            totalUnresolvedThreads: unresolvedThreadCount,
            untrustedSkips: untrustedSkips.map((s) => ({
              commentId: s.commentId,
              author: s.author,
              authorAssociation: s.authorAssociation,
              reason: s.reason,
              viewerDidAuthor: s.viewerDidAuthor ?? null,
            })),
          },
          'Zero-trusted unresolved threads — retaining waiting-for:address-pr-feedback label (FR-002)',
        );
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
        // Don't throw here — we still need to run the blocked disposition.
      }

      // 7a. Disposition B short-circuit (#883): CLI did not complete cleanly OR
      // there is no diff. Both mean the loop cannot advance on this cycle —
      // add `blocked:stuck-feedback-loop` and leave `waiting-for:*` intact so
      // the operator sees the pause. Do NOT reply, do NOT resolve, do NOT log
      // success.
      if (!success || !hasChanges) {
        this.logger.warn(
          {
            prNumber,
            issueNumber,
            trigger: 'unresolvedThreads>0',
            reason: !success ? 'cli-did-not-complete' : 'no-diff',
          },
          'no-diff cycle — persisting trigger, entering blocked-stuck-feedback-loop disposition',
        );
        await this.addBlockedStuckFeedbackLoopLabel(github, owner, repo, issueNumber);
        return;
      }

      // 7b. Happy path — CLI succeeded AND we have a real commit.
      const shortSha = (await this.getHeadShortSha(checkoutPath)) ?? '<unknown>';

      // 8. Interleaved reply→resolve per root thread (#883, Q4-C, FR-005,
      // FR-007). Input-set closure: iterate `trustedUnresolvedThreads`
      // captured at cycle start.
      const outcomes: PerThreadOutcome[] = [];
      for (const thread of trustedUnresolvedThreads) {
        const replyBody = `Addressed in ${shortSha} — please review, and re-open this thread if it still falls short.`;
        const replyResult = await this.tryPostReply(
          github, owner, repo, prNumber, thread.rootCommentId, replyBody,
        );
        const resolveResult = await this.tryResolveReviewThread(github, thread.id);
        outcomes.push({
          threadId: thread.id,
          rootCommentId: thread.rootCommentId,
          replyResult,
          resolveResult,
        });
      }

      // 9. Strict-decrease success test (#883, FR-006, FR-010).
      const resolveSuccesses = outcomes.filter(o => o.resolveResult.ok).length;
      const resolveFailures = outcomes.filter(o => !o.resolveResult.ok);

      if (resolveSuccesses === 0) {
        // FR-006 tail — commit landed but no thread transitioned.
        this.logger.warn(
          { prNumber, issueNumber, outcomes },
          'commit pushed but resolve batch had zero successes — persisting trigger, entering blocked-stuck-feedback-loop disposition',
        );
        await this.addBlockedStuckFeedbackLoopLabel(github, owner, repo, issueNumber);
        return;
      }

      // FR-010: one warn per persistently-failed thread, emitted BEFORE
      // clearing the label so a silent partial failure is impossible.
      for (const f of resolveFailures) {
        this.logger.warn(
          {
            prNumber, issueNumber, owner, repo,
            threadId: f.threadId,
            rootCommentId: f.rootCommentId,
            error: (f.resolveResult as { ok: false; error: string }).error,
            remedy: 'Resolve the thread manually in the GitHub UI — the reply is already on the thread',
          },
          'resolveReviewThread persistently failed after retries; label will still be cleared',
        );
      }

      // 10. Label-clear LAST (Q4 tail). #926 FR-006: coalesce the happy-path
      // clear into a single `removeLabels` call so `waiting-for:*` and
      // `agent:in-progress` disappear in one request — no intermediate state
      // where cockpit / auto observers see one label without the other.
      // The `finally` clear becomes a no-op on this path (idempotent remove).
      try {
        await github.removeLabels(owner, repo, issueNumber, [
          WAITING_FOR_ADDRESS_PR_FEEDBACK_LABEL,
          AGENT_IN_PROGRESS_LABEL,
        ]);
        this.logger.info(
          { issueNumber },
          'Removed waiting-for:address-pr-feedback + agent:in-progress labels (coalesced)',
        );
      } catch (error) {
        this.logger.warn(
          { error: String(error), issueNumber },
          'Failed to remove happy-path labels — non-fatal, finally will re-attempt in-progress clear',
        );
      }
      this.logger.info(
        {
          prNumber, issueNumber,
          resolveSuccesses,
          resolveFailures: resolveFailures.length,
          shortSha,
        },
        'PR feedback cycle succeeded (strict decrease met)',
      );
    } catch (error) {
      this.logger.error(
        { error: String(error), prNumber, issueNumber, owner, repo },
        'Error processing PR feedback — task failed',
      );
      throw error;
    } finally {
      // #926 SC-004: structural single-point clear. Every terminal exit
      // (Case A, Case B, both blocked-stuck dispositions, happy path, and
      // thrown errors) flows through here. Non-fatal on failure.
      await this.clearInProgressLabel(github, owner, repo, issueNumber);
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

    // #842: fence ingested thread content (author-trust filtered upstream).
    const fenced = wrapUntrustedData(commentList, `PR #${prNumber} review comments`);

    return `You are addressing PR review feedback for PR #${prNumber} (linked to issue #${issueNumber}).

The following unresolved review comments need to be addressed:

${fenced}

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
      const handle = await this.agentLauncher.launch({
        intent: {
          kind: 'pr-feedback',
          prNumber,
          prompt,
        } as PrFeedbackIntent,
        cwd: checkoutPath,
        env: {},
        credentials: buildLaunchCredentials(this.config.credentialRole),
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
   * Post a single reply targeting the root comment of a review thread.
   * Returns a discriminated result — failures do not throw so the caller
   * (#883 per-thread outcome loop) can aggregate results.
   */
  private async tryPostReply(
    github: GitHubClient,
    owner: string,
    repo: string,
    prNumber: number,
    rootCommentId: number,
    body: string,
  ): Promise<OutcomeResult> {
    try {
      await github.replyToPRComment(owner, repo, prNumber, rootCommentId, body);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  /**
   * Delegate to `github.resolveReviewThread` (which owns the 3× retry). Wraps
   * the result in a discriminated union so the caller can aggregate outcomes
   * without a try/catch (#883).
   */
  private async tryResolveReviewThread(
    github: GitHubClient,
    threadId: string,
  ): Promise<OutcomeResult> {
    try {
      await github.resolveReviewThread(threadId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  /**
   * Read the short SHA of the just-pushed HEAD commit. Returns null when the
   * git command fails; caller falls back to `<unknown>` in the reply body —
   * the SHA is decoration, not termination logic (#883).
   */
  private async getHeadShortSha(checkoutPath: string): Promise<string | null> {
    try {
      const result = await executeCommand(
        'git',
        ['rev-parse', '--short', 'HEAD'],
        { cwd: checkoutPath },
      );
      if (result.exitCode !== 0) return null;
      const sha = result.stdout.trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  /**
   * Add the `blocked:stuck-feedback-loop` label to signal that the fix cycle
   * cannot advance and must not be re-enqueued until the operator removes the
   * label. Non-fatal on failure — leaving `waiting-for:*` in place is the
   * fallback safety net (#883).
   */
  private async addBlockedStuckFeedbackLoopLabel(
    github: GitHubClient,
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<void> {
    try {
      await github.addLabels(owner, repo, issueNumber, [BLOCKED_STUCK_FEEDBACK_LOOP_LABEL]);
      this.logger.info(
        { issueNumber, label: BLOCKED_STUCK_FEEDBACK_LOOP_LABEL },
        'Added blocked:stuck-feedback-loop label',
      );
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber, label: BLOCKED_STUCK_FEEDBACK_LOOP_LABEL },
        'Failed to add blocked:stuck-feedback-loop label — non-fatal, waiting-for label persists',
      );
    }
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
      await github.removeLabels(owner, repo, issueNumber, [WAITING_FOR_ADDRESS_PR_FEEDBACK_LABEL]);
      this.logger.info({ issueNumber }, 'Removed waiting-for:address-pr-feedback label');
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber },
        'Failed to remove waiting-for:address-pr-feedback label — non-fatal',
      );
    }
  }

  /**
   * Structural clear of `agent:in-progress` on the linked issue (#926 SC-004).
   * Called from the shared `finally` block in `handle()` — runs on every
   * terminal exit path (Cases A/B, both blocked-stuck dispositions, happy
   * path, and thrown errors). Idempotent: GitHub's `removeLabels` is a no-op
   * when the label is already absent, so the happy-path coalesced removal +
   * this `finally` clear together produce at most one truthful post-state.
   */
  private async clearInProgressLabel(
    github: GitHubClient,
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<void> {
    try {
      await github.removeLabels(owner, repo, issueNumber, [AGENT_IN_PROGRESS_LABEL]);
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber },
        'Failed to remove agent:in-progress label — non-fatal',
      );
    }
  }
}
