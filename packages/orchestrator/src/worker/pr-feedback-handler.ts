import {
  createGitHubClient,
  executeCommand,
  isTrustedCommentAuthor,
  tryLoadCommentTrustConfig,
  wrapUntrustedData,
} from '@generacy-ai/workflow-engine';
import type { Comment, GitHubClient, Review, ReviewThread } from '@generacy-ai/workflow-engine';
import { evaluatePushGuard, type PushGuardDecision } from './push-guard.js';
import { defaultRemoteBranchExists } from './repo-checkout.js';
import {
  parseAcknowledgedFindings,
  parseSingleMarkerEntries,
  BODY_FINDINGS_UNADDRESSED_MARKER,
} from './pr-feedback-ack-parser.js';
import { parseReviewBody, type ParsedReview } from './pr-feedback-body-parser.js';
import { evaluateBodyGate, type UnaddressedFinding } from './pr-feedback-body-gate.js';
import type { QueueItem, PrFeedbackMetadata } from '../types/index.js';
import type { Logger } from './types.js';
import type { WorkerConfig } from './config.js';
import { resolveAgentForPhase } from './config.js';
import type { SSEEventEmitter } from './output-capture.js';
import type { AgentLauncher } from '../launcher/agent-launcher.js';
import type { PrFeedbackIntent } from '@generacy-ai/generacy-plugin-claude-code';
import { OutputCapture } from './output-capture.js';
import { RepoCheckout } from './repo-checkout.js';
import { buildLaunchCredentials } from './credentials-helper.js';

/** Label added by the handler when the fix cycle cannot advance (#883). */
const BLOCKED_STUCK_FEEDBACK_LOOP_LABEL = 'blocked:stuck-feedback-loop';

/**
 * Label added by Disposition C (#1047) when the fixer completed a cycle
 * without touching any file named by an unaddressed review-body finding.
 * The monitor's bare `l.startsWith('blocked:')` skip gate honors this
 * without any allow-list change (see FR-007 grep verification).
 */
const BLOCKED_BODY_FINDING_UNADDRESSED_LABEL = 'blocked:body-finding-unaddressed';

/**
 * `agent:in-progress` label — cleared structurally at the single shared exit
 * path (#926 SC-004/SC-005). Extracted to a module constant so the literal
 * appears at exactly one code site: the coalesced happy-path removal and the
 * `clearInProgressLabel` fallback both reference this constant.
 */
const AGENT_IN_PROGRESS_LABEL = 'agent:in-progress';

/** Waiting gate cleared alongside `agent:in-progress` on the happy path. */
const WAITING_FOR_ADDRESS_PR_FEEDBACK_LABEL = 'waiting-for:address-pr-feedback';

/** #941 FR-002: gate label the fix session must leave present on every exit. */
const WAITING_FOR_IMPLEMENTATION_REVIEW_LABEL = 'waiting-for:implementation-review';

/** Set equality by size + element containment (both are Sets of primitives). */
function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

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
      let parsedReviews: ParsedReview[] = [];
      let relevantReviews: Review[] = [];
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

      // 3b. #1047: also fetch review submissions so top-level review-body
      // findings that name files NOT in the diff still reach the fixer prompt
      // (inline threads only surface findings anchored to a file+line). Failure
      // is log-and-continue — the thread path is independent and must still run.
      //
      // #1047 Finding 3: apply the same author-trust filter used for inline
      // review comments. Any GitHub user can submit a COMMENTED review, and
      // an unfiltered untrusted body can (a) inject prompt content into the
      // fixer and (b) pin the loop on Disposition C by naming files nothing
      // can touch. Trust ordering mirrors the inline path — bot-login match
      // first, then author_association tier + config-widen.
      try {
        const reviews = await github.listReviews(owner, repo, prNumber);
        const stateAndBodyOK = reviews.filter(
          (r: Review) =>
            (r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED') &&
            r.body.trim().length > 0,
        );
        const trustConfig = tryLoadCommentTrustConfig(checkoutPath, this.logger);
        const botLogin = process.env['CLUSTER_GITHUB_USERNAME'] ?? process.env['GH_USERNAME'];
        const untrustedReviewSkips: Array<{
          reviewId: number;
          author: string;
          authorAssociation: string | undefined;
          reason: string;
        }> = [];
        for (const r of stateAndBodyOK) {
          // Build a Comment-shaped stub for `isTrustedCommentAuthor`. `viewerDidAuthor`
          // is set to `false` explicitly (not undefined) because the REST reviews
          // endpoint does not expose GraphQL's `viewerDidAuthor` primitive — our
          // own bot-authored reviews are captured by the bot-login match above the
          // viewerDidAuthor branch in the trust helper. Passing `false` also
          // silences the migrated-surfaces shape-drift warn (see comment-trust.ts).
          const stub: Comment = {
            id: r.id,
            body: r.body,
            author: r.user.login,
            created_at: r.submittedAt,
            updated_at: r.submittedAt,
            viewerDidAuthor: false,
            ...(r.authorAssociation ? { authorAssociation: r.authorAssociation } : {}),
          };
          const decision = isTrustedCommentAuthor(stub, 'pr-feedback', {
            logger: this.logger,
            ...(botLogin ? { botLogin } : {}),
            ...(trustConfig ? { config: trustConfig } : {}),
          });
          if (decision.trusted) {
            relevantReviews.push(r);
          } else {
            untrustedReviewSkips.push({
              reviewId: r.id,
              author: r.user.login,
              authorAssociation: r.authorAssociation,
              reason: decision.reason,
            });
            this.logger.info(
              {
                event: 'review-body-skipped',
                surface: 'pr-feedback',
                reviewId: r.id,
                author: r.user.login,
                authorAssociation: r.authorAssociation,
                reason: decision.reason,
              },
              'Skipped PR review body from untrusted author (#1047 Finding 3)',
            );
          }
        }
        parsedReviews = relevantReviews.map(parseReviewBody);
        this.logger.info(
          {
            prNumber,
            totalReviews: reviews.length,
            trustedRelevantReviews: relevantReviews.length,
            untrustedReviewSkips: untrustedReviewSkips.length,
          },
          'Fetched PR reviews for body-consumption path (#1047, trust-filtered)',
        );
      } catch (error) {
        this.logger.warn(
          { error: String(error), prNumber, owner, repo },
          'Failed to fetch PR reviews (#1047 body-consumption path) — continuing with thread-only inputs',
        );
        parsedReviews = [];
        relevantReviews = [];
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

      // #1047 T011: extend the prompt inputs with each non-empty review body.
      // buildFeedbackPrompt renders items without path/line as
      // "general comment" — no renderer change required. Ordering is not
      // load-bearing (FR-006).
      const reviewBodyItems: Comment[] = relevantReviews.map(r => ({
        id: r.id,
        body: `review body (no file anchor):\n\n${r.body}`,
        author: r.user.login,
        created_at: r.submittedAt,
        updated_at: r.submittedAt,
      }));
      const promptInputs: Comment[] = [...unresolvedComments, ...reviewBodyItems];

      // 5. Build structured prompt
      const prompt = this.buildFeedbackPrompt(promptInputs, prNumber, issueNumber);

      // #1047 Finding 2: capture HEAD SHA BEFORE spawning the fixer so the
      // touched-file gate can diff `<preFixSha>..HEAD` — the ACTUAL fix-cycle
      // scope. The previous `origin/<base>..HEAD` diff returned every file the
      // PR ever changed, so any body finding naming an in-diff file was
      // auto-satisfied without the fixer touching it. Null on git failure
      // → gate degrades to "nothing touched" (safe direction, per
      // getCommitTouchedFiles).
      const preFixSha = await this.getHeadSha(checkoutPath);

      // 6. Spawn Claude CLI to address feedback
      const success = await this.spawnClaudeForFeedback(
        checkoutPath,
        prompt,
        workflowId,
        prNumber,
        item.workflowName,
      );

      // 7. Commit and push changes (even on timeout — partial completion strategy)
      // FR-013: Push partial changes on timeout to preserve work and enable retry
      //
      // #1051 FR-002/003: pre-push guard — refuse the push if the PR has already
      // merged/closed or the remote branch is missing. Prevents a re-entering
      // worker from resurrecting a deleted branch and opening a duplicate PR
      // that claims to close the already-closed issue (generacy-cloud#883).
      const guardDecision = await evaluatePushGuard({
        owner,
        repo,
        issueNumber,
        branch: branchName,
        github,
        git: { remoteBranchExists: (b) => defaultRemoteBranchExists(b, checkoutPath) },
      });
      if (guardDecision.kind === 'refuse') {
        await this.handlePushRefused(github, guardDecision);
        return;
      }

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
      //
      // #1047 Finding 5 (FR-007): the body-finding gate MUST run AFTER this
      // loop. FR-007's hold fires only "after thread resolves succeed", so the
      // monitor's Case C reset (totalUnresolvedThreads === 0) fires on the
      // next poll before the blocked:* skip check. Placing the gate before the
      // resolve loop would leave inline threads unresolved and unreplied — the
      // reviewer sees no "Addressed in <sha>" acknowledgment and the next
      // cycle re-feeds already-fixed inline comments to the fixer.
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

      // 9b. #1047 T013 (FR-003, FR-007): per-finding body-gate. Runs AFTER
      // the reply/resolve loop so unresolved-thread count decays to zero
      // regardless of Disposition C outcome (Finding 5). Diff scope is the
      // fix-cycle SHA range (`<preFixSha>..HEAD`), NOT the whole PR — otherwise
      // a body finding naming a file already in the PR diff auto-satisfies
      // without the fixer touching it (Finding 2).
      const commitTouchedFiles = preFixSha
        ? await this.getCommitTouchedFiles(checkoutPath, preFixSha, 'HEAD')
        : new Set<string>();
      let existingCommentBodies: string[] = [];
      try {
        existingCommentBodies = await github.listPrCommentBodies(owner, repo, prNumber);
      } catch (error) {
        this.logger.warn(
          { error: String(error), prNumber, owner, repo },
          'Failed to list PR comment bodies (#1047 ack parse) — treating ack set as empty',
        );
      }
      const acknowledged = parseAcknowledgedFindings(existingCommentBodies);
      const gateResult = evaluateBodyGate({
        parsedReviews,
        commitTouchedFiles,
        acknowledged,
      });

      if (!gateResult.satisfied) {
        this.logger.warn(
          {
            prNumber,
            issueNumber,
            unaddressedCount: gateResult.unaddressed.length,
            unaddressed: gateResult.unaddressed,
            commitTouchedFileCount: commitTouchedFiles.size,
            preFixSha: preFixSha ?? '<unknown>',
          },
          'body-finding gate unsatisfied — entering Disposition C (#1047)',
        );
        await this.applyDispositionC(
          github,
          owner,
          repo,
          prNumber,
          issueNumber,
          gateResult.unaddressed,
          existingCommentBodies,
        );
        // Keep `waiting-for:address-pr-feedback` in place (mirrors Disposition
        // B); the `blocked:body-finding-unaddressed` label pauses the monitor
        // and the operator's removal of it re-opens the loop.
        return;
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
      // #941 FR-002: re-assert waiting-for:implementation-review BEFORE
      // clearing agent:in-progress, so no terminal transient state is
      // { agent:in-progress present, waiting-for:implementation-review absent }.
      await this.ensureImplementationReviewGate(github, owner, repo, issueNumber, prNumber);
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
    workflowName: string,
  ): Promise<boolean> {
    // #814 / Q1→B: pr-feedback resolves `{ provider, model }` against the
    // `implement` phase — pr-feedback revises the code `implement` produced,
    // so the same agent/model that wrote the code should address review on it.
    const { provider, model } = resolveAgentForPhase(this.config, workflowName, 'implement');

    this.logger.info(
      { cwd: checkoutPath, timeoutMs: this.config.phaseTimeoutMs, provider, model },
      'Spawning Claude CLI for PR feedback',
    );

    let child;
    try {
      const handle = await this.agentLauncher.launch({
        intent: {
          kind: 'pr-feedback',
          prNumber,
          prompt,
          ...(model !== undefined ? { model } : {}),
        } as PrFeedbackIntent,
        cwd: checkoutPath,
        env: {},
        credentials: buildLaunchCredentials(this.config.credentialRole),
        provider,
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
   * List the files changed between two git refs. Used by the #1047
   * per-finding body-gate to decide whether the just-pushed commit(s) touched
   * any file named by a review-body finding. Follows the shape of
   * `getHeadShortSha` — returns an empty set on any git failure so the gate
   * degrades to "nothing touched" (which then flags everything as unaddressed
   * → Disposition C, the safe direction).
   *
   * `<baseRef>..<headRef>` is the natural diff range for a multi-commit
   * fix cycle (FR-013 partial completion may push more than one commit),
   * so this deliberately does NOT use `getStatus()` (which is empty after
   * push).
   */
  private async getCommitTouchedFiles(
    checkoutPath: string,
    baseRef: string,
    headRef: string,
  ): Promise<Set<string>> {
    try {
      const result = await executeCommand(
        'git',
        ['diff', '--name-only', `${baseRef}..${headRef}`],
        { cwd: checkoutPath },
      );
      if (result.exitCode !== 0) {
        this.logger.warn(
          {
            event: 'get-commit-touched-files-failed',
            baseRef,
            headRef,
            stderr: result.stderr,
          },
          'git diff for touched-files enumeration failed — gate will treat cycle as touching nothing',
        );
        return new Set();
      }
      const files = result.stdout
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);
      return new Set(files);
    } catch (error) {
      this.logger.warn(
        { error: String(error), baseRef, headRef },
        'getCommitTouchedFiles threw — gate will treat cycle as touching nothing',
      );
      return new Set();
    }
  }

  /**
   * Read the full SHA of the current HEAD commit. Used by the #1047
   * Finding-2 fix as the pre-fix anchor for the touched-file gate: it must be
   * captured BEFORE spawning the fixer so `<preFixSha>..HEAD` isolates the
   * cycle's commits (as opposed to `origin/<base>..HEAD` which returns every
   * file the PR ever changed). Returns null on git failure — caller falls
   * back to an empty touched-file set, which flags all body findings as
   * unaddressed (safe direction).
   */
  private async getHeadSha(checkoutPath: string): Promise<string | null> {
    try {
      const result = await executeCommand(
        'git',
        ['rev-parse', 'HEAD'],
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
   * Apply Disposition C (#1047): the fixer cycle committed changes but did
   * not touch any file named by an unaddressed review-body finding. Add the
   * `blocked:body-finding-unaddressed` label and post a marker-keyed top-level
   * PR comment enumerating the unaddressed findings for operator triage AND
   * for the next cycle's acknowledgment set (FR-008). Both operations are
   * best-effort; failures are logged but not thrown so the shared `finally`
   * still runs.
   */
  private async applyDispositionC(
    github: GitHubClient,
    owner: string,
    repo: string,
    prNumber: number,
    issueNumber: number,
    unaddressed: UnaddressedFinding[],
    existingCommentBodies: readonly string[],
  ): Promise<void> {
    try {
      await github.addLabels(owner, repo, issueNumber, [
        BLOCKED_BODY_FINDING_UNADDRESSED_LABEL,
      ]);
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber, label: BLOCKED_BODY_FINDING_UNADDRESSED_LABEL },
        'Failed to add blocked:body-finding-unaddressed label — non-fatal, comment carries the same info',
      );
    }

    // #1047 Finding 4: skip posting ONLY when a prior marker enumerates the
    // EXACT SAME unaddressed set (per `contracts/body-findings-unaddressed-marker.md`
    // § Idempotency). Bare marker-presence is not sufficient — subsequent
    // reviews can introduce new findings, and each new set must post its own
    // marker so both the operator triage AND the next cycle's acknowledgment
    // set contain the current enumeration.
    const currentKeys = new Set(
      unaddressed.map((u) => `${u.reviewer}:${u.reviewId}:${u.findingIndex}`),
    );
    const priorMarkerBodies = existingCommentBodies.filter((b) =>
      b.includes(BODY_FINDINGS_UNADDRESSED_MARKER),
    );
    const alreadyEnumerated = priorMarkerBodies.some((b) => {
      const priorKeys = parseSingleMarkerEntries(b);
      return setsEqual(priorKeys, currentKeys);
    });
    if (alreadyEnumerated) {
      this.logger.debug(
        {
          prNumber,
          issueNumber,
          unaddressedCount: unaddressed.length,
          priorMarkerCount: priorMarkerBodies.length,
        },
        'Disposition-C marker comment already enumerates this exact set — skipping duplicate post',
      );
      return;
    }

    const body = this.buildDispositionCComment(unaddressed);
    try {
      await github.postPrComment(owner, repo, prNumber, body);
      this.logger.info(
        { prNumber, issueNumber, unaddressedCount: unaddressed.length },
        'Posted Disposition-C marker comment (#1047)',
      );
    } catch (error) {
      this.logger.warn(
        { error: String(error), prNumber, issueNumber },
        'Failed to post Disposition-C marker comment — non-fatal, label alone conveys the pause',
      );
    }
  }

  /**
   * Build the marker-keyed Disposition-C comment body per
   * `contracts/body-findings-unaddressed-marker.md` (#1047). Ordering:
   * findings sorted by (reviewId asc, findingIndex asc) for readability;
   * ack-parser is order-insensitive.
   */
  private buildDispositionCComment(unaddressed: UnaddressedFinding[]): string {
    const sorted = [...unaddressed].sort((a, b) => {
      if (a.reviewId !== b.reviewId) return a.reviewId - b.reviewId;
      return a.findingIndex - b.findingIndex;
    });
    const rows = sorted
      .map(u => {
        const files = u.namedFiles.map(f => '`' + f + '`').join(', ');
        return `- \`${u.reviewer}\` review #${u.reviewId} finding ${u.findingIndex} (files: ${files})`;
      })
      .join('\n');
    return `${BODY_FINDINGS_UNADDRESSED_MARKER}

⚠️ **Body findings not yet addressed by the fixer**

The fixer completed this cycle without touching any file named by the
following review-body findings. To unblock:

- Address the findings manually, OR
- Remove the \`${BLOCKED_BODY_FINDING_UNADDRESSED_LABEL}\` label to acknowledge —
  a subsequent NEW review from the same author will re-gate its findings.

### Unaddressed findings

${rows}

_This is an automated notice from the PR-feedback body-consumption path (#1047)._`;
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

  /**
   * #1051 FR-003: react to a `refuse` decision from the pre-push guard.
   *
   * - Emit exactly one warn log with `event: 'push-refused'` and the fields
   *   named in FR-003a — reason, prNumber, branch, owner, repo, issueNumber.
   * - Apply FR-003b label state: clear `agent:in-progress` unconditionally;
   *   also add `agent:error` when the linked issue is still `open` (an open
   *   issue + merged/missing branch is a genuine anomaly worth surfacing).
   *   Never add `failed:<phase>` — that would invite `/cockpit:resume` to
   *   re-attempt the refused push and turn the fix into a loop (invariant I-6).
   *
   * Best-effort throughout: label failures are non-fatal so the caller's
   * shared `finally` still runs.
   */
  private async handlePushRefused(
    github: GitHubClient,
    decision: Extract<PushGuardDecision, { kind: 'refuse' }>,
  ): Promise<void> {
    const { reason, prNumber, branch, owner, repo, issueNumber } = decision;

    this.logger.warn(
      { event: 'push-refused', reason, prNumber, branch, owner, repo, issueNumber },
      'Refusing push — PR state or remote branch state indicates a resurrection or duplicate-PR attempt',
    );

    // Read issue.state so FR-003b can decide whether to add `agent:error`.
    // Best-effort: on read failure, treat as `open` (safer to surface than to
    // silently swallow — a stale-cache issue can be dismissed by the operator).
    let issueState: 'open' | 'closed' = 'open';
    try {
      const issue = await github.getIssue(owner, repo, issueNumber);
      issueState = issue.state;
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber },
        'handlePushRefused: failed to read issue state — assuming open',
      );
    }

    // Always clear agent:in-progress. The shared `finally` will also try, but
    // clearing here first bounds the window an observer sees the label pinned.
    try {
      await github.removeLabels(owner, repo, issueNumber, [AGENT_IN_PROGRESS_LABEL]);
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber },
        'handlePushRefused: failed to remove agent:in-progress — non-fatal (finally will retry)',
      );
    }

    if (issueState === 'open') {
      try {
        await github.addLabels(owner, repo, issueNumber, ['agent:error']);
      } catch (error) {
        this.logger.warn(
          { error: String(error), issueNumber },
          'handlePushRefused: failed to add agent:error — non-fatal',
        );
      }
    }
  }

  /**
   * #941 FR-002: after the fix session terminates, assert that
   * `waiting-for:implementation-review` is still on the linked issue. If it is
   * missing (some other code path stripped it between pause and exit), emit a
   * structured `error` log AND idempotently re-add the label. Non-fatal on
   * failure — never throws so the shared `finally` in `handle()` cannot break
   * on `agent:in-progress` cleanup.
   *
   * Ordering: called from `handle()`'s shared `finally` BEFORE
   * `clearInProgressLabel(...)` so the terminal transient state is never
   * `{ agent:in-progress present, waiting-for:implementation-review absent }`.
   */
  private async ensureImplementationReviewGate(
    github: GitHubClient,
    owner: string,
    repo: string,
    issueNumber: number,
    prNumber: number,
  ): Promise<void> {
    let labels: string[];
    try {
      const issue = await github.getIssue(owner, repo, issueNumber);
      labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
    } catch (err) {
      this.logger.warn(
        { err: String(err), issueNumber, prNumber },
        'ensureImplementationReviewGate: failed to read labels — non-fatal',
      );
      return;
    }

    if (labels.includes(WAITING_FOR_IMPLEMENTATION_REVIEW_LABEL)) {
      this.logger.debug(
        { issueNumber, prNumber },
        'ensureImplementationReviewGate: gate label already present',
      );
      return;
    }

    this.logger.error(
      {
        event: 'gate-label-missing-at-fix-exit',
        owner,
        repo,
        issueNumber,
        pr: prNumber,
      },
      'waiting-for:implementation-review missing at fix-session exit — re-adding (FR-002)',
    );

    try {
      await github.addLabels(owner, repo, issueNumber, [
        WAITING_FOR_IMPLEMENTATION_REVIEW_LABEL,
      ]);
    } catch (err) {
      this.logger.warn(
        { err: String(err), issueNumber, prNumber },
        'ensureImplementationReviewGate: failed to re-add gate label — non-fatal',
      );
    }
  }
}
