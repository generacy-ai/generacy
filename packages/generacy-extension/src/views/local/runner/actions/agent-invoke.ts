/**
 * Agent invoke action handler.
 * Handles Claude Code CLI invocation with JSON output parsing.
 */
import { BaseAction } from './base-action';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
  AgentInvokeInput,
  AgentInvokeOutput,
} from './types';
import { parseActionType } from './types';
import type { WorkflowStep } from '../types';
import { executeCommand, checkCLI, extractJSON } from './cli-utils';

/**
 * Action handler for agent.invoke (Claude Code CLI)
 */
export class AgentInvokeAction extends BaseAction {
  readonly type: ActionType = 'agent.invoke';

  canHandle(step: WorkflowStep): boolean {
    return parseActionType(step) === 'agent.invoke';
  }

  validate(step: WorkflowStep): ValidationResult {
    const errors = [];
    const warnings = [];

    // Get input from step's 'with' field
    const inputs = (step as WorkflowStep & { with?: AgentInvokeInput }).with;

    if (!inputs?.prompt) {
      errors.push({
        field: 'with.prompt',
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
    step: WorkflowStep,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Check claude CLI availability
    const claudeStatus = await checkCLI('claude');
    if (!claudeStatus.available) {
      return this.failureResult(
        claudeStatus.error ||
          'Claude Code CLI is not available. Install it with: npm install -g @anthropic/claude-code'
      );
    }

    // Get input parameters
    const inputs = this.getStepInputs(step, context);
    const { prompt, allowedTools, timeout, maxTurns, workdir } = inputs;

    if (!prompt) {
      return this.failureResult('Prompt is required');
    }

    context.logger.info(`Invoking agent with prompt: ${prompt.substring(0, 50)}...`);

    try {
      // Build CLI arguments
      const args = [
        '--output-format', 'json',
        '--print', 'all',
        '-p', prompt,
      ];

      // Add optional arguments
      if (maxTurns !== undefined) {
        args.push('--max-turns', String(maxTurns));
      }

      if (allowedTools && allowedTools.length > 0) {
        args.push('--allowed-tools', allowedTools.join(','));
      }

      // Calculate timeout (default: 5 minutes, or step timeout)
      const execTimeout = timeout ? timeout * 1000 : (step.timeout || 300000);

      // Execute Claude CLI
      const result = await executeCommand('claude', args, {
        cwd: workdir || context.workdir,
        env: context.env,
        timeout: execTimeout,
        signal: context.signal,
      });

      // Parse JSON output
      const parsedOutput = extractJSON(result.stdout);

      if (result.exitCode !== 0) {
        return this.failureResult(
          `Agent invocation failed: ${result.stderr || 'Unknown error'}`,
          {
            output: parsedOutput,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }
        );
      }

      // Extract structured output
      const output = this.parseAgentOutput(parsedOutput, result.stdout);

      context.logger.info(`Agent completed: ${output.summary.substring(0, 50)}...`);

      return this.successResult(output, {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        filesModified: output.filesModified,
      });
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Extract input parameters from step
   */
  private getStepInputs(
    step: WorkflowStep,
    context: ActionContext
  ): AgentInvokeInput {
    const stepInputs = (step as WorkflowStep & { with?: Record<string, unknown> }).with || {};

    return {
      prompt: String(stepInputs['prompt'] ?? this.getInput(step, context, 'prompt') ?? ''),
      allowedTools: stepInputs['allowedTools'] as string[] | undefined ??
                    this.getInput<string[]>(step, context, 'allowedTools'),
      timeout: stepInputs['timeout'] as number | undefined ??
               this.getInput<number>(step, context, 'timeout'),
      maxTurns: stepInputs['maxTurns'] as number | undefined ??
                this.getInput<number>(step, context, 'maxTurns'),
      workdir: stepInputs['workdir'] as string | undefined ??
               this.getInput<string>(step, context, 'workdir'),
    };
  }

  /**
   * Parse agent output from CLI response
   */
  private parseAgentOutput(parsed: unknown, raw: string): AgentInvokeOutput {
    // Default output structure
    const defaultOutput: AgentInvokeOutput = {
      summary: 'Agent completed execution',
      filesModified: [],
      turns: 0,
    };

    if (!parsed || typeof parsed !== 'object') {
      // Try to extract summary from raw output
      return {
        ...defaultOutput,
        summary: raw.substring(0, 200) || 'Agent completed execution',
      };
    }

    const data = parsed as Record<string, unknown>;

    // Handle different output formats from Claude CLI
    if (data['type'] === 'complete' && data['data']) {
      const completeData = data['data'] as Record<string, unknown>;
      return {
        summary: String(completeData['summary'] ?? defaultOutput.summary),
        filesModified: Array.isArray(completeData['filesModified'])
          ? completeData['filesModified'].map(String)
          : [],
        conversationId: completeData['conversationId'] as string | undefined,
        turns: Number(completeData['turns'] ?? 0),
        data: completeData,
      };
    }

    // Handle direct output format
    return {
      summary: String(data['summary'] ?? data['result'] ?? defaultOutput.summary),
      filesModified: Array.isArray(data['filesModified'])
        ? data['filesModified'].map(String)
        : Array.isArray(data['files'])
          ? data['files'].map(String)
          : [],
      conversationId: data['conversationId'] as string | undefined,
      turns: Number(data['turns'] ?? data['total_turns'] ?? 0),
      data: data as Record<string, unknown>,
    };
  }
}
