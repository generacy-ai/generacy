/**
 * workflow.check_gate action - checks review gate status.
 * Determines if a workflow can proceed past a review gate.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  CheckGateInput,
  CheckGateOutput,
  ReviewGate,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from '../github/client/index.js';
import { createGitHubClient } from '../github/client/index.js';

/**
 * workflow.check_gate action handler
 */
export class CheckGateAction extends BaseAction {
  readonly type: ActionIdentifier = 'workflow.check_gate';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'workflow.check_gate' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const issueNumber = this.getRequiredInput<number>(step, context, 'issue_number');
    const phase = this.getRequiredInput<ReviewGate>(step, context, 'phase');

    context.logger.info(`Checking gate ${phase} for issue #${issueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Get issue labels
      const issue = await client.getIssue(repoInfo.owner, repoInfo.repo, issueNumber);
      const labels = issue.labels.map(l => l.name);

      // Check for gate-related labels
      const needsLabel = `needs:${phase}`;
      const waitingLabel = `waiting-for:${phase}`;
      const completedLabel = `completed:${phase}`;

      const hasNeeds = labels.includes(needsLabel);
      const hasWaiting = labels.includes(waitingLabel);
      const hasCompleted = labels.includes(completedLabel);

      // Determine gate status
      let canProceed = true;
      let gateActive = false;
      let waitingFor: string | undefined;
      let completed: string | undefined;
      let blockedReason: string | undefined;

      if (hasNeeds || hasWaiting) {
        gateActive = true;
        if (!hasCompleted) {
          canProceed = false;
          waitingFor = phase;
          blockedReason = `Waiting for ${phase} approval`;
        } else {
          completed = phase;
        }
      }

      if (hasCompleted) {
        completed = phase;
      }

      const output: CheckGateOutput = {
        can_proceed: canProceed,
        gate_active: gateActive,
        waiting_for: waitingFor,
        completed,
        blocked_reason: blockedReason,
      };

      context.logger.info(`Gate check result: can_proceed=${canProceed}`);

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
