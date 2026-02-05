/**
 * github.commit_and_push action - commits changes with issue reference and pushes.
 * Handles staging, committing with proper message format, and pushing to remote.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  CommitAndPushInput,
  CommitAndPushOutput,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';

/**
 * github.commit_and_push action handler
 */
export class CommitAndPushAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.commit_and_push';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.commit_and_push' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const message = this.getRequiredInput<string>(step, context, 'message');
    const issueNumber = this.getRequiredInput<number>(step, context, 'issue_number');
    const files = this.getInput<string[]>(step, context, 'files');

    context.logger.info(`Committing changes for issue #${issueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Check for changes to commit
      const status = await client.getStatus();
      if (!status.has_changes) {
        return this.successResult({
          commit_sha: '',
          pushed: false,
          files_committed: [],
        } as CommitAndPushOutput);
      }

      // Stage files
      if (files && files.length > 0) {
        await client.stageFiles(files);
      } else {
        // Stage all changes
        await client.stageAll();
      }

      // Format commit message with issue reference
      const formattedMessage = this.formatCommitMessage(message, issueNumber);

      // Commit
      const commitResult = await client.commit(formattedMessage);
      context.logger.info(`Committed: ${commitResult.sha.substring(0, 7)}`);

      // Push
      const currentBranch = await client.getCurrentBranch();
      await client.push('origin', currentBranch, true);
      context.logger.info(`Pushed to origin/${currentBranch}`);

      const output: CommitAndPushOutput = {
        commit_sha: commitResult.sha,
        pushed: true,
        files_committed: commitResult.files_committed,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Format commit message with issue reference
   */
  private formatCommitMessage(message: string, issueNumber: number): string {
    // Check if message already contains issue reference
    if (message.includes(`#${issueNumber}`)) {
      return message;
    }

    // Add issue reference
    // Check for conventional commit prefix
    const conventionalMatch = message.match(/^(feat|fix|chore|docs|style|refactor|test|perf|ci|build)(\(.+\))?:\s*/);
    if (conventionalMatch) {
      const prefix = conventionalMatch[0];
      const rest = message.substring(prefix.length);
      return `${prefix}${rest} (#${issueNumber})`;
    }

    // Just append
    return `${message} (#${issueNumber})`;
  }
}
