/**
 * Agent Step Executor
 *
 * Executor for agent-type steps that invoke AI agent commands.
 */

import type { WorkflowStep, AgentStepConfig } from '../types/WorkflowDefinition.js';
import { isAgentStepConfig } from '../types/WorkflowDefinition.js';
import type { WorkflowContext } from '../types/WorkflowContext.js';
import type { StepExecutionResult, StepExecutor } from '../engine/WorkflowRuntime.js';
import { BaseStepExecutor } from './StepExecutor.js';

/**
 * Command executor function type.
 * Implementations should handle the actual command invocation.
 */
export type CommandExecutor = (
  command: string,
  mode: AgentStepConfig['mode'],
  args: Record<string, unknown> | undefined,
  context: WorkflowContext
) => Promise<CommandResult>;

/**
 * Result of executing a command
 */
export interface CommandResult {
  /** Whether the command succeeded */
  success: boolean;

  /** Output from the command */
  output?: unknown;

  /** Error message if failed */
  error?: string;
}

/**
 * Default command executor that simulates command execution.
 * In production, this would be replaced with actual command invocation.
 */
export const defaultCommandExecutor: CommandExecutor = async (command, mode, args) => {
  // Simulate command execution
  return {
    success: true,
    output: {
      command,
      mode,
      args,
      simulated: true,
      timestamp: new Date().toISOString(),
    },
  };
};

/**
 * Executor for agent-type steps.
 */
export class AgentStepExecutor extends BaseStepExecutor {
  private commandExecutor: CommandExecutor;

  constructor(commandExecutor: CommandExecutor = defaultCommandExecutor) {
    super();
    this.commandExecutor = commandExecutor;
  }

  async execute(step: WorkflowStep, context: WorkflowContext): Promise<StepExecutionResult> {
    if (!isAgentStepConfig(step.config)) {
      return this.failure('INVALID_CONFIG', 'Step config is not an AgentStepConfig');
    }

    const config = step.config;

    try {
      const result = await this.commandExecutor(
        config.command,
        config.mode,
        config.args,
        context
      );

      if (!result.success) {
        return this.failure('COMMAND_FAILED', result.error ?? 'Command execution failed');
      }

      return this.success(result.output);
    } catch (error) {
      return this.failure(
        'EXECUTION_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

/**
 * Create an agent step executor function.
 */
export function createAgentStepExecutor(commandExecutor?: CommandExecutor): StepExecutor {
  const executor = new AgentStepExecutor(commandExecutor);
  return async (step, context) => executor.execute(step, context);
}
