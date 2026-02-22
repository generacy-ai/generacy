/**
 * SpecKit action handler.
 * Implements speckit workflow operations for spec-driven development methodology.
 *
 * Operations are divided into two categories:
 * - Deterministic: Direct library calls (create_feature, get_paths, check_prereqs, copy_template)
 * - AI-dependent: Agent delegation (specify, clarify, plan, tasks, implement)
 */
import { BaseAction } from '../../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
  ValidationError,
  StepDefinition,
} from '../../../types/index.js';
import { parseActionType } from '../../../types/action.js';
import type {
  SpecKitOperation,
  CreateFeatureInput,
  CreateFeatureOutput,
  GetPathsInput,
  GetPathsOutput,
  CheckPrereqsInput,
  CheckPrereqsOutput,
  CopyTemplateInput,
  CopyTemplateOutput,
  SpecifyInput,
  SpecifyOutput,
  ClarifyInput,
  ClarifyOutput,
  PlanInput,
  PlanOutput,
  TasksInput,
  TasksOutput,
  ImplementInput,
  ImplementOutput,
} from './types.js';
import type { TasksToIssuesInput } from '../../../types/index.js';

// Import operation handlers
import { executeCreateFeature } from './operations/create-feature.js';
import { executeGetPaths } from './operations/get-paths.js';
import { executeCheckPrereqs } from './operations/check-prereqs.js';
import { executeCopyTemplate } from './operations/copy-template.js';
import { executeSpecify } from './operations/specify.js';
import { executeClarify } from './operations/clarify.js';
import { executePlan } from './operations/plan.js';
import { executeTasks } from './operations/tasks.js';
import { executeImplement } from './operations/implement.js';
import { executeTasksToIssues } from './operations/tasks-to-issues.js';

/** Valid speckit operations */
const VALID_OPERATIONS: Set<SpecKitOperation> = new Set([
  'create_feature',
  'get_paths',
  'check_prereqs',
  'copy_template',
  'specify',
  'clarify',
  'plan',
  'tasks',
  'implement',
  'tasks_to_issues',
]);

/**
 * Action handler for speckit workflow operations.
 * Dispatches to specific operation handlers based on the operation extracted from step.uses/step.action.
 */
export class SpecKitAction extends BaseAction {
  readonly type: ActionType = 'speckit';

  /**
   * Check if this handler can process the given step
   */
  canHandle(step: StepDefinition): boolean {
    const uses = step.uses || step.action || '';
    return uses.startsWith('speckit.') || uses.startsWith('speckit/');
  }

  /**
   * Extract operation name from step definition
   * @param step Workflow step definition
   * @returns Operation name (e.g., 'create_feature', 'specify')
   */
  protected extractOperation(step: StepDefinition): string {
    const actionString = step.uses || step.action || '';
    // Match speckit.create_feature or speckit/create_feature
    const match = actionString.match(/^speckit[./](.+)$/);
    return match?.[1] || '';
  }

  /**
   * Validate step configuration before execution
   */
  validate(step: StepDefinition): ValidationResult {
    const errors: ValidationError[] = [];

    const operation = this.extractOperation(step);

    if (!operation) {
      errors.push({
        field: 'uses',
        message: 'Speckit operation not specified. Use format: speckit.<operation>',
        code: 'MISSING_OPERATION',
      });
      return { valid: false, errors, warnings: [] };
    }

    if (!VALID_OPERATIONS.has(operation as SpecKitOperation)) {
      errors.push({
        field: 'uses',
        message: `Unknown speckit operation: ${operation}. Valid operations: ${[...VALID_OPERATIONS].join(', ')}`,
        code: 'INVALID_OPERATION',
      });
      return { valid: false, errors, warnings: [] };
    }

    // Operation-specific validation
    switch (operation as SpecKitOperation) {
      case 'create_feature': {
        const description = step.with?.['description'];
        if (!description) {
          errors.push({
            field: 'description',
            message: 'Description is required for create_feature operation',
            code: 'MISSING_DESCRIPTION',
          });
        }
        break;
      }
      case 'specify':
      case 'plan':
      case 'tasks':
      case 'implement': {
        const featureDir = step.with?.['feature_dir'];
        if (!featureDir) {
          errors.push({
            field: 'feature_dir',
            message: `feature_dir is required for ${operation} operation`,
            code: 'MISSING_FEATURE_DIR',
          });
        }
        break;
      }
      case 'clarify': {
        const featureDir = step.with?.['feature_dir'];
        if (!featureDir) {
          errors.push({
            field: 'feature_dir',
            message: 'feature_dir is required for clarify operation',
            code: 'MISSING_FEATURE_DIR',
          });
        }
        break;
      }
      case 'copy_template': {
        const templates = step.with?.['templates'];
        if (!templates || !Array.isArray(templates) || templates.length === 0) {
          errors.push({
            field: 'templates',
            message: 'templates array is required for copy_template operation',
            code: 'MISSING_TEMPLATES',
          });
        }
        break;
      }
      case 'tasks_to_issues': {
        const featureDir = step.with?.['feature_dir'];
        if (!featureDir) {
          errors.push({
            field: 'feature_dir',
            message: 'feature_dir is required for tasks_to_issues operation',
            code: 'MISSING_FEATURE_DIR',
          });
        }
        const epicIssueNumber = step.with?.['epic_issue_number'];
        if (epicIssueNumber == null) {
          errors.push({
            field: 'epic_issue_number',
            message: 'epic_issue_number is required for tasks_to_issues operation',
            code: 'MISSING_EPIC_ISSUE_NUMBER',
          });
        }
        const epicBranch = step.with?.['epic_branch'];
        if (!epicBranch) {
          errors.push({
            field: 'epic_branch',
            message: 'epic_branch is required for tasks_to_issues operation',
            code: 'MISSING_EPIC_BRANCH',
          });
        }
        break;
      }
      // get_paths and check_prereqs have optional inputs
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * Execute the speckit operation
   */
  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const operation = this.extractOperation(step) as SpecKitOperation;

    if (!operation || !VALID_OPERATIONS.has(operation)) {
      return this.failureResult(`Invalid speckit operation: ${operation}`);
    }

    context.logger.info(`Executing speckit.${operation}`);

    try {
      switch (operation) {
        case 'create_feature':
          return await this.handleCreateFeature(step, context);
        case 'get_paths':
          return await this.handleGetPaths(step, context);
        case 'check_prereqs':
          return await this.handleCheckPrereqs(step, context);
        case 'copy_template':
          return await this.handleCopyTemplate(step, context);
        case 'specify':
          return await this.handleSpecify(step, context);
        case 'clarify':
          return await this.handleClarify(step, context);
        case 'plan':
          return await this.handlePlan(step, context);
        case 'tasks':
          return await this.handleTasks(step, context);
        case 'implement':
          return await this.handleImplement(step, context);
        case 'tasks_to_issues':
          return await this.handleTasksToIssues(step, context);
        default:
          return this.failureResult(`Unhandled speckit operation: ${operation}`);
      }
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // --- Deterministic Operation Handlers (Library Calls) ---

  private async handleCreateFeature(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: CreateFeatureInput = {
      description: this.getRequiredInput<string>(step, context, 'description'),
      short_name: this.getInput<string>(step, context, 'short_name'),
      number: this.getInput<number>(step, context, 'number'),
      parent_epic_branch: this.getInput<string>(step, context, 'parent_epic_branch'),
      cwd: this.getInput<string>(step, context, 'cwd', context.workdir),
    };

    const result = await executeCreateFeature(input, context.logger);

    if (result.success) {
      return this.successResult(result, {
        filesModified: [result.spec_file],
      });
    }
    return this.failureResult('create_feature operation failed', { output: result });
  }

  private async handleGetPaths(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: GetPathsInput = {
      branch: this.getInput<string>(step, context, 'branch'),
      cwd: this.getInput<string>(step, context, 'cwd', context.workdir),
    };

    const result = await executeGetPaths(input, context.logger);

    if (result.success) {
      return this.successResult(result);
    }
    return this.failureResult('get_paths operation failed', { output: result });
  }

  private async handleCheckPrereqs(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: CheckPrereqsInput = {
      branch: this.getInput<string>(step, context, 'branch'),
      require_spec: this.getInput<boolean>(step, context, 'require_spec', true),
      require_plan: this.getInput<boolean>(step, context, 'require_plan', false),
      require_tasks: this.getInput<boolean>(step, context, 'require_tasks', false),
      include_tasks: this.getInput<boolean>(step, context, 'include_tasks', false),
      cwd: this.getInput<string>(step, context, 'cwd', context.workdir),
    };

    const result = await executeCheckPrereqs(input, context.logger);

    if (result.valid) {
      return this.successResult(result);
    }
    return this.failureResult(result.error || 'check_prereqs failed', { output: result });
  }

  private async handleCopyTemplate(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: CopyTemplateInput = {
      templates: this.getRequiredInput<string[]>(step, context, 'templates') as CopyTemplateInput['templates'],
      feature_dir: this.getInput<string>(step, context, 'feature_dir'),
      dest_filename: this.getInput<string>(step, context, 'dest_filename'),
      cwd: this.getInput<string>(step, context, 'cwd', context.workdir),
    };

    const result = await executeCopyTemplate(input, context.logger);

    if (result.success) {
      return this.successResult(result, {
        filesModified: result.copied.map(c => c.destPath),
      });
    }
    return this.failureResult('copy_template operation failed', { output: result });
  }

  // --- AI-Dependent Operation Handlers (Agent Delegation) ---

  private async handleSpecify(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: SpecifyInput = {
      feature_dir: this.getRequiredInput<string>(step, context, 'feature_dir'),
      issue_url: this.getInput<string>(step, context, 'issue_url'),
      timeout: this.getInput<number>(step, context, 'timeout', 300),
    };

    const result = await executeSpecify(input, context);

    if (result.success) {
      return this.successResult(result, {
        filesModified: [result.spec_file],
      });
    }
    return this.failureResult('specify operation failed', { output: result });
  }

  private async handleClarify(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: ClarifyInput = {
      feature_dir: this.getRequiredInput<string>(step, context, 'feature_dir'),
      issue_number: this.getInput<number>(step, context, 'issue_number'),
      timeout: this.getInput<number>(step, context, 'timeout', 300),
    };

    const result = await executeClarify(input, context);

    if (result.success) {
      return this.successResult(result, {
        filesModified: [result.clarifications_file],
      });
    }
    return this.failureResult('clarify operation failed', { output: result });
  }

  private async handlePlan(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: PlanInput = {
      feature_dir: this.getRequiredInput<string>(step, context, 'feature_dir'),
      timeout: this.getInput<number>(step, context, 'timeout', 600),
    };

    const result = await executePlan(input, context);

    if (result.success) {
      return this.successResult(result, {
        filesModified: [result.plan_file, ...result.artifacts_created],
      });
    }
    return this.failureResult('plan operation failed', { output: result });
  }

  private async handleTasks(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: TasksInput = {
      feature_dir: this.getRequiredInput<string>(step, context, 'feature_dir'),
      timeout: this.getInput<number>(step, context, 'timeout', 300),
    };

    const result = await executeTasks(input, context);

    if (result.success) {
      return this.successResult(result, {
        filesModified: [result.tasks_file],
      });
    }
    return this.failureResult('tasks operation failed', { output: result });
  }

  private async handleImplement(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: ImplementInput = {
      feature_dir: this.getRequiredInput<string>(step, context, 'feature_dir'),
      task_filter: this.getInput<string>(step, context, 'task_filter'),
      timeout: this.getInput<number>(step, context, 'timeout', 600),
    };

    const result = await executeImplement(input, context);

    if (result.success) {
      return this.successResult(result, {
        filesModified: result.files_modified,
      });
    }
    return this.failureResult('implement operation failed', { output: result });
  }

  // --- Epic Operation Handlers ---

  private async handleTasksToIssues(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: TasksToIssuesInput = {
      feature_dir: this.getRequiredInput<string>(step, context, 'feature_dir'),
      epic_issue_number: this.getRequiredInput<number>(step, context, 'epic_issue_number'),
      epic_branch: this.getRequiredInput<string>(step, context, 'epic_branch'),
      trigger_label: this.getInput<string>(step, context, 'trigger_label'),
    };

    const result = await executeTasksToIssues(input, context);

    if (result.failed_tasks.length > 0 && result.created_issues.length === 0) {
      return this.failureResult(
        `tasks_to_issues failed: all ${result.failed_tasks.length} tasks failed to create issues`,
        { output: result }
      );
    }

    return this.successResult(result);
  }
}

// Export types for external use
export * from './types.js';
