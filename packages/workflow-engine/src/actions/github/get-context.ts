/**
 * github.get_context action - retrieves spec artifacts for context.
 * Loads spec.md, plan.md, tasks.md and determines current phase.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  GetContextInput,
  GetContextOutput,
  CorePhase,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Determine current phase from tasks.md content
 */
function determinePhaseFromTasks(tasks: string): CorePhase {
  // Check if all tasks are complete
  const incompleteTasks = tasks.match(/- \[ \]/g);
  const completeTasks = tasks.match(/- \[x\]/gi);

  if (!incompleteTasks || incompleteTasks.length === 0) {
    return 'validate'; // All done
  }

  if (!completeTasks || completeTasks.length === 0) {
    return 'implement'; // Starting implementation
  }

  return 'implement'; // In progress
}

/**
 * github.get_context action handler
 */
export class GetContextAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.get_context';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.get_context' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const issueNumber = this.getRequiredInput<number>(step, context, 'issue_number');
    const parentEpicNumber = this.getInput<number>(step, context, 'parent_epic_number');
    const issueBody = this.getInput<string>(step, context, 'issue_body');

    context.logger.info(`Getting context for issue #${issueNumber}`);

    try {
      // Find feature directory
      const specsDir = join(context.workdir, 'specs');
      const featureDir = this.findFeatureDir(specsDir, issueNumber);

      if (!featureDir) {
        return this.failureResult(`No spec directory found for issue #${issueNumber}`);
      }

      const featurePath = join(specsDir, featureDir);

      // Read artifacts
      const spec = this.readArtifact(featurePath, 'spec.md');
      const plan = this.readArtifact(featurePath, 'plan.md');
      const tasks = this.readArtifact(featurePath, 'tasks.md');

      // Determine phase
      let phase: CorePhase = 'specify';
      if (spec && !plan) phase = 'plan';
      else if (plan && !tasks) phase = 'tasks';
      else if (tasks) phase = determinePhaseFromTasks(tasks);

      // Build output
      const output: GetContextOutput = {
        spec,
        plan,
        tasks,
        phase,
        feature_dir: featurePath,
      };

      // If this is an epic child, load parent context
      if (parentEpicNumber) {
        const parentDir = this.findFeatureDir(specsDir, parentEpicNumber);
        if (parentDir) {
          const parentPath = join(specsDir, parentDir);
          output.epic_context = {
            parent_spec: this.readArtifact(parentPath, 'spec.md'),
            parent_plan: this.readArtifact(parentPath, 'plan.md'),
            parent_tasks: this.readArtifact(parentPath, 'tasks.md'),
          };
        }
      }

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Find the feature directory for an issue number
   */
  private findFeatureDir(specsDir: string, issueNumber: number): string | undefined {
    if (!existsSync(specsDir)) {
      return undefined;
    }

    const dirs = readdirSync(specsDir);
    return dirs.find(d => d.startsWith(`${issueNumber}-`));
  }

  /**
   * Read an artifact file, returning undefined if it doesn't exist
   */
  private readArtifact(featurePath: string, filename: string): string | undefined {
    const filepath = join(featurePath, filename);
    if (!existsSync(filepath)) {
      return undefined;
    }
    return readFileSync(filepath, 'utf-8');
  }
}
