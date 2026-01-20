/**
 * AgentHandler - Handles agent job execution via the registry.
 */

import type { Job } from '../../scheduler/types.js';
import type {
  JobResult,
  AgentJobPayload,
  AgentHandlerConfig,
} from '../types.js';
import type {
  AgentInvoker,
  InvocationConfig,
} from '../../agents/types.js';
import type { AgentRegistry } from '../../agents/agent-registry.js';
import { AgentNotFoundError } from '../../agents/errors.js';

/**
 * Handler for agent jobs - invokes AI agents via the registry.
 */
export class AgentHandler {
  private registry: AgentRegistry;
  private config: AgentHandlerConfig;
  private static readonly DEFAULT_AGENT = 'claude-code';

  constructor(registry: AgentRegistry, config: AgentHandlerConfig) {
    this.registry = registry;
    this.config = config;
  }

  /**
   * Handle an agent job by invoking the appropriate agent.
   */
  async handle(job: Job): Promise<JobResult> {
    const startTime = Date.now();
    const payload = job.payload as AgentJobPayload;

    // Get agent from registry - use specified agent or default
    const agentName = payload.agent ?? AgentHandler.DEFAULT_AGENT;
    const agent = this.registry.get(agentName) as AgentInvoker | undefined;

    if (!agent) {
      throw new AgentNotFoundError(agentName);
    }

    // Build invocation config
    const invocationConfig: InvocationConfig = {
      command: payload.command,
      context: {
        workingDirectory: payload.context.workingDirectory,
        environment: payload.context.environment,
        mode: payload.context.mode,
        issueNumber: payload.context.issueNumber,
        branch: payload.context.branch,
      },
      timeout: payload.timeout ?? this.config.defaultTimeout,
    };

    try {
      // Invoke the agent
      const result = await agent.invoke(invocationConfig);

      const duration = Date.now() - startTime;

      // Convert InvocationResult to JobResult
      return {
        success: result.success,
        output: result.output,
        duration,
        metadata: {
          exitCode: result.exitCode,
          toolCalls: result.toolCalls,
          agentName,
          ...(result.error && { error: result.error }),
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Handle agent invocation errors
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
        duration,
        metadata: {
          agentName,
          error: {
            code: 'INVOCATION_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }
}
