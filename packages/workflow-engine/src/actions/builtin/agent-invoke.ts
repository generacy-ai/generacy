/**
 * Agent invoke action handler.
 * Handles Claude CLI invocation for AI agent tasks.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  StepDefinition,
  AgentInvokeInput,
  AgentInvokeOutput,
} from '../../types/index.js';
import { parseActionType } from '../../types/action.js';
import { executeCommand, extractJSON } from '../cli-utils.js';

/**
 * Action handler for agent (Claude CLI) invocation
 */
export class AgentInvokeAction extends BaseAction {
  readonly type: ActionType = 'agent.invoke';

  canHandle(step: StepDefinition): boolean {
    return parseActionType(step) === 'agent.invoke';
  }

  validate(step: StepDefinition): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Check for prompt - use empty context for validation
    const prompt = step.with?.['prompt'];

    if (!prompt) {
      errors.push({
        field: 'prompt',
        message: 'Prompt is required for agent.invoke action',
        code: 'MISSING_PROMPT',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: AgentInvokeInput = {
      prompt: this.getRequiredInput<string>(step, context, 'prompt'),
      allowedTools: this.getInput<string[]>(step, context, 'allowedTools'),
      timeout: this.getInput<number>(step, context, 'timeout', 600), // 10 minute default
      maxTurns: this.getInput<number>(step, context, 'maxTurns'),
      workdir: this.getInput<string>(step, context, 'workdir', context.workdir),
    };

    context.logger.info(`Invoking Claude agent with prompt: ${input.prompt.substring(0, 50)}...`);

    try {
      // Build claude command arguments
      const args: string[] = ['-p', input.prompt, '--output-format', 'json'];

      // Add max turns if specified
      if (input.maxTurns) {
        args.push('--max-turns', String(input.maxTurns));
      }

      // Add allowed tools if specified
      if (input.allowedTools && input.allowedTools.length > 0) {
        args.push('--allowedTools', input.allowedTools.join(','));
      }

      // Execute claude CLI
      const result = await executeCommand('claude', args, {
        cwd: input.workdir ?? context.workdir,
        env: this.mergeEnv(context, step.env),
        timeout: (input.timeout ?? 600) * 1000, // Convert to ms
        signal: context.signal,
      });

      // Parse JSON output
      const parsedOutput = extractJSON(result.stdout);

      // Check exit code
      if (result.exitCode !== 0) {
        return this.failureResult(
          `Claude agent failed with exit code ${result.exitCode}`,
          {
            output: parsedOutput ?? result.stdout,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }
        );
      }

      // Extract structured output
      const agentOutput: AgentInvokeOutput = {
        summary: 'Agent completed successfully',
        filesModified: [],
        turns: 1,
        data: parsedOutput as Record<string, unknown> | undefined,
      };

      // Try to extract more details from parsed output
      if (parsedOutput && typeof parsedOutput === 'object') {
        const parsed = parsedOutput as Record<string, unknown>;
        if (typeof parsed['summary'] === 'string') {
          agentOutput.summary = parsed['summary'];
        }
        if (Array.isArray(parsed['filesModified'])) {
          agentOutput.filesModified = parsed['filesModified'] as string[];
        }
        if (typeof parsed['turns'] === 'number') {
          agentOutput.turns = parsed['turns'];
        }
        if (typeof parsed['conversationId'] === 'string') {
          agentOutput.conversationId = parsed['conversationId'];
        }
      }

      context.logger.info(`Agent completed: ${agentOutput.summary}`);

      return this.successResult(agentOutput, {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        filesModified: agentOutput.filesModified,
      });
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
