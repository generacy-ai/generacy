/**
 * github.read_pr_feedback action - gets unresolved PR comments.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  ReadPRFeedbackInput,
  ReadPRFeedbackOutput,
  Comment,
} from '../../types/index.js';
import type { SkippedCommentInfo } from '../../types/github.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';
import { isTrustedCommentAuthor } from '../../security/comment-trust.js';
import { tryLoadCommentTrustConfig } from '../../security/comment-trust-config.js';

/**
 * github.read_pr_feedback action handler
 */
export class ReadPRFeedbackAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.read_pr_feedback';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.read_pr_feedback' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const prNumber = this.getRequiredInput<number>(step, context, 'pr_number');
    const includeResolved = this.getInput<boolean>(step, context, 'include_resolved', false);

    context.logger.info(`Reading feedback for PR #${prNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Get PR comments
      const allComments = await client.getPRComments(repoInfo.owner, repoInfo.repo, prNumber);

      // Filter based on resolved status
      let comments: Comment[];
      if (includeResolved) {
        comments = allComments;
      } else {
        comments = allComments.filter(c => c.resolved !== true);
      }

      // Author-trust gating (#842). Partition into trusted (surfaced to
      // agent) + skippedComments (metadata only, for downstream logging).
      const trustConfig = tryLoadCommentTrustConfig(context.workdir, context.logger);
      const botLogin = process.env['CLUSTER_GITHUB_USERNAME'] ?? process.env['GH_USERNAME'];
      const trustedComments: Comment[] = [];
      const skippedComments: SkippedCommentInfo[] = [];
      for (const c of comments) {
        const decision = isTrustedCommentAuthor(
          c,
          'pr-feedback',
          {
            logger: context.logger,
            ...(botLogin ? { botLogin } : {}),
            ...(trustConfig ? { config: trustConfig } : {}),
          },
        );
        if (decision.trusted) {
          trustedComments.push(c);
        } else {
          skippedComments.push({
            commentId: c.id,
            author: c.author,
            ...(c.authorAssociation !== undefined ? { authorAssociation: c.authorAssociation } : {}),
            reason: decision.reason,
          });
        }
      }

      const unresolvedCount = trustedComments.filter(c => c.resolved === false).length;

      const output: ReadPRFeedbackOutput = {
        comments: trustedComments,
        has_unresolved: unresolvedCount > 0,
        unresolved_count: unresolvedCount,
        ...(skippedComments.length > 0 ? { skippedComments } : {}),
      };

      context.logger.info(
        `Found ${trustedComments.length} trusted comments (${unresolvedCount} unresolved); skipped ${skippedComments.length} untrusted`,
      );

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
