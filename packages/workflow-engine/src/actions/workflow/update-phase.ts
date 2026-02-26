/**
 * workflow.update_phase action - manages phase labels on issues.
 * Handles starting, completing, and blocking phases.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  UpdatePhaseInput,
  UpdatePhaseOutput,
  CorePhase,
  ReviewGate,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from '../github/client/index.js';
import { createGitHubClient } from '../github/client/index.js';

/**
 * Phase label mappings
 */
const PHASE_LABELS: Record<string, string> = {
  specify: 'phase:specify',
  clarify: 'phase:clarify',
  plan: 'phase:plan',
  tasks: 'phase:tasks',
  implement: 'phase:implement',
  validate: 'phase:validate',
};

const COMPLETED_LABELS: Record<string, string> = {
  specify: 'completed:specify',
  clarify: 'completed:clarify',
  plan: 'completed:plan',
  tasks: 'completed:tasks',
  implement: 'completed:implement',
  validate: 'completed:validate',
};

const WAITING_FOR_LABELS: Record<string, string> = {
  'spec-review': 'waiting-for:spec-review',
  'clarification': 'waiting-for:clarification',
  'clarification-review': 'waiting-for:clarification-review',
  'plan-review': 'waiting-for:plan-review',
  'tasks-review': 'waiting-for:tasks-review',
  'implementation-review': 'waiting-for:implementation-review',
  'manual-validation': 'waiting-for:manual-validation',
  'address-pr-feedback': 'waiting-for:address-pr-feedback',
  'children-complete': 'waiting-for:children-complete',
};

/**
 * workflow.update_phase action handler
 */
export class UpdatePhaseAction extends BaseAction {
  readonly type: ActionIdentifier = 'workflow.update_phase';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'workflow.update_phase' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const issueNumber = this.getRequiredInput<number>(step, context, 'issue_number');
    const phase = this.getRequiredInput<string>(step, context, 'phase');
    const action = this.getRequiredInput<string>(step, context, 'action');

    context.logger.info(`Updating phase labels: ${phase} (${action}) for issue #${issueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      const labelsAdded: string[] = [];
      const labelsRemoved: string[] = [];

      switch (action) {
        case 'start':
          // Remove waiting-for label for this phase
          if (WAITING_FOR_LABELS[phase]) {
            try {
              await client.removeLabels(repoInfo.owner, repoInfo.repo, issueNumber, [WAITING_FOR_LABELS[phase]!]);
              labelsRemoved.push(WAITING_FOR_LABELS[phase]!);
            } catch {
              // Label might not exist
            }
          }
          break;

        case 'complete': {
          // Add completed label for review gates
          const completedLabel = `completed:${phase}`;
          await client.addLabels(repoInfo.owner, repoInfo.repo, issueNumber, [completedLabel]);
          labelsAdded.push(completedLabel);
          // Remove waiting-for label
          if (WAITING_FOR_LABELS[phase]) {
            try {
              await client.removeLabels(repoInfo.owner, repoInfo.repo, issueNumber, [WAITING_FOR_LABELS[phase]!]);
              labelsRemoved.push(WAITING_FOR_LABELS[phase]!);
            } catch {
              // Label might not exist
            }
          }
          break;
        }

        case 'block':
          // Add waiting-for label
          if (WAITING_FOR_LABELS[phase]) {
            await client.addLabels(repoInfo.owner, repoInfo.repo, issueNumber, [WAITING_FOR_LABELS[phase]!]);
            labelsAdded.push(WAITING_FOR_LABELS[phase]!);
          }
          break;

        case 'set_current':
          // Set the current phase label
          if (PHASE_LABELS[phase]) {
            // Remove other phase labels first
            const otherPhaseLabels = Object.values(PHASE_LABELS).filter(l => l !== PHASE_LABELS[phase]);
            try {
              await client.removeLabels(repoInfo.owner, repoInfo.repo, issueNumber, otherPhaseLabels);
              labelsRemoved.push(...otherPhaseLabels);
            } catch {
              // Labels might not exist
            }
            // Add current phase label
            await client.addLabels(repoInfo.owner, repoInfo.repo, issueNumber, [PHASE_LABELS[phase]!]);
            labelsAdded.push(PHASE_LABELS[phase]!);
          }
          break;

        case 'add_completion':
          // Add completed label for core phases
          if (COMPLETED_LABELS[phase]) {
            await client.addLabels(repoInfo.owner, repoInfo.repo, issueNumber, [COMPLETED_LABELS[phase]!]);
            labelsAdded.push(COMPLETED_LABELS[phase]!);
          }
          break;

        default:
          return this.failureResult(`Unknown action: ${action}`);
      }

      context.logger.info(`Labels added: ${labelsAdded.join(', ') || 'none'}`);
      context.logger.info(`Labels removed: ${labelsRemoved.join(', ') || 'none'}`);

      const output: UpdatePhaseOutput = {
        success: true,
        phase,
        action,
        labels_added: labelsAdded,
        labels_removed: labelsRemoved,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
