/**
 * Human Step Executor
 *
 * Executor for human-type steps that pause workflow for human input.
 */

import type { WorkflowStep, HumanStepConfig } from '../types/WorkflowDefinition.js';
import { isHumanStepConfig } from '../types/WorkflowDefinition.js';
import type { WorkflowContext } from '../types/WorkflowContext.js';
import type { StepExecutionResult, StepExecutor } from '../engine/WorkflowRuntime.js';
import { BaseStepExecutor } from './StepExecutor.js';

/**
 * Notification handler for human steps.
 * Called when a workflow enters waiting state for human input.
 */
export type HumanStepNotifier = (
  stepId: string,
  action: HumanStepConfig['action'],
  urgency: HumanStepConfig['urgency'],
  prompt: string | undefined,
  options: string[] | undefined,
  context: WorkflowContext
) => Promise<void>;

/**
 * Default notifier that logs to console.
 */
export const defaultNotifier: HumanStepNotifier = async (
  stepId,
  action,
  urgency,
  prompt
) => {
  console.log(`[Human Step ${stepId}] Action: ${action}, Urgency: ${urgency}`);
  if (prompt) {
    console.log(`  Prompt: ${prompt}`);
  }
};

/**
 * Executor for human-type steps.
 * These steps pause the workflow until human input is provided.
 */
export class HumanStepExecutor extends BaseStepExecutor {
  private notifier: HumanStepNotifier;

  constructor(notifier: HumanStepNotifier = defaultNotifier) {
    super();
    this.notifier = notifier;
  }

  async execute(step: WorkflowStep, context: WorkflowContext): Promise<StepExecutionResult> {
    if (!isHumanStepConfig(step.config)) {
      return this.failure('INVALID_CONFIG', 'Step config is not a HumanStepConfig');
    }

    const config = step.config;

    try {
      // Notify that human input is required
      await this.notifier(
        step.id,
        config.action,
        config.urgency,
        config.prompt,
        config.options,
        context
      );

      // Return waiting state - workflow will pause here
      return this.waiting({
        stepId: step.id,
        action: config.action,
        urgency: config.urgency,
        prompt: config.prompt,
        options: config.options,
      });
    } catch (error) {
      return this.failure(
        'NOTIFICATION_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

/**
 * Create a human step executor function.
 */
export function createHumanStepExecutor(notifier?: HumanStepNotifier): StepExecutor {
  const executor = new HumanStepExecutor(notifier);
  return async (step, context) => executor.execute(step, context);
}

/**
 * Validate human input against step configuration.
 */
export function validateHumanInput(
  input: unknown,
  config: HumanStepConfig
): { valid: boolean; error?: string } {
  switch (config.action) {
    case 'approve':
      // Expect boolean approval
      if (typeof input !== 'boolean') {
        return { valid: false, error: 'Expected boolean approval' };
      }
      return { valid: true };

    case 'review':
      // Expect review result object
      if (typeof input !== 'object' || input === null) {
        return { valid: false, error: 'Expected review result object' };
      }
      return { valid: true };

    case 'input':
      // Accept any input
      return { valid: true };

    case 'decide':
      // Expect one of the options if options are defined
      if (config.options && config.options.length > 0) {
        if (typeof input !== 'string' || !config.options.includes(input)) {
          return { valid: false, error: `Expected one of: ${config.options.join(', ')}` };
        }
      }
      return { valid: true };

    default:
      return { valid: true };
  }
}
