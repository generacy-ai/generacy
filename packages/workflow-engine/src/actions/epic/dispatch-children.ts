/**
 * epic.dispatch_children action - sends child issues to orchestrator queue.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  DispatchChildrenInput,
  DispatchChildrenOutput,
  DispatchFailure,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from '../github/client/index.js';
import { createGitHubClient } from '../github/client/index.js';

/**
 * epic.dispatch_children action handler
 */
export class DispatchChildrenAction extends BaseAction {
  readonly type: ActionIdentifier = 'epic.dispatch_children';

  // Default agent account to assign dispatched issues to
  private readonly AGENT_ACCOUNT = 'generacy-bot';
  private readonly DISPATCHED_LABEL = 'agent:dispatched';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'epic.dispatch_children' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const epicIssueNumber = this.getRequiredInput<number>(step, context, 'epic_issue_number');
    const childIssues = this.getRequiredInput<number[]>(step, context, 'child_issues');

    if (!Array.isArray(childIssues) || childIssues.length === 0) {
      return this.failureResult('child_issues must be a non-empty array of issue numbers');
    }

    context.logger.info(`Dispatching ${childIssues.length} children from epic #${epicIssueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Get agent account from environment or use default
      const agentAccount = process.env.GENERACY_AGENT_ACCOUNT ?? this.AGENT_ACCOUNT;

      const dispatched: number[] = [];
      const failed: DispatchFailure[] = [];

      // Process each child issue
      for (const issueNumber of childIssues) {
        try {
          // Verify the issue exists and is open
          const issue = await client.getIssue(repoInfo.owner, repoInfo.repo, issueNumber);

          if (issue.state !== 'open') {
            failed.push({
              issue_number: issueNumber,
              reason: `Issue is ${issue.state}, not open`,
            });
            continue;
          }

          // Check if already dispatched
          const labels = issue.labels.map(l => l.name);
          if (labels.includes(this.DISPATCHED_LABEL)) {
            failed.push({
              issue_number: issueNumber,
              reason: 'Already dispatched',
            });
            continue;
          }

          // Assign to agent account
          await client.updateIssue(repoInfo.owner, repoInfo.repo, issueNumber, {
            assignees: [agentAccount],
          });

          // Add dispatched label
          await client.addLabels(
            repoInfo.owner,
            repoInfo.repo,
            issueNumber,
            [this.DISPATCHED_LABEL]
          );

          dispatched.push(issueNumber);
          context.logger.info(`Dispatched #${issueNumber}`);
        } catch (error) {
          failed.push({
            issue_number: issueNumber,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const output: DispatchChildrenOutput = {
        dispatched,
        failed,
        agent_account: agentAccount,
      };

      // Consider success if at least one was dispatched
      if (dispatched.length > 0) {
        return this.successResult(output);
      } else if (failed.length > 0) {
        return this.failureResult(
          `Failed to dispatch any children: ${failed.map(f => `#${f.issue_number}: ${f.reason}`).join(', ')}`
        );
      }

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
