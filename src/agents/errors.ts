/**
 * Error types for the agent invocation abstraction layer.
 *
 * Hybrid error handling:
 * - Throw exceptions for infrastructure errors (agent unavailable, initialization failed)
 * - Return InvocationResult with success=false for invocation failures (timeout, non-zero exit)
 */

/** Error thrown when an agent is not available in the environment */
export class AgentUnavailableError extends Error {
  constructor(agentName: string, reason?: string) {
    const message = reason
      ? `Agent "${agentName}" is not available: ${reason}`
      : `Agent "${agentName}" is not available`;
    super(message);
    this.name = 'AgentUnavailableError';
  }
}

/** Error thrown when agent initialization fails */
export class AgentInitializationError extends Error {
  constructor(agentName: string, reason?: string) {
    const message = reason
      ? `Failed to initialize agent "${agentName}": ${reason}`
      : `Failed to initialize agent "${agentName}"`;
    super(message);
    this.name = 'AgentInitializationError';
  }
}

/** Error thrown when an agent is not found in the registry */
export class AgentNotFoundError extends Error {
  constructor(agentName: string) {
    super(`Agent "${agentName}" not found in registry`);
    this.name = 'AgentNotFoundError';
  }
}

/** Error thrown when no default agent is configured */
export class DefaultAgentNotConfiguredError extends Error {
  constructor() {
    super('No default agent configured');
    this.name = 'DefaultAgentNotConfiguredError';
  }
}

/** Error thrown when registering an agent that already exists */
export class AgentExistsError extends Error {
  constructor(agentName: string) {
    super(`Agent "${agentName}" already registered`);
    this.name = 'AgentExistsError';
  }
}

/**
 * Error codes for invocation failures (returned in InvocationResult.error).
 *
 * These are NOT thrown as exceptions - they're returned in the result
 * to distinguish expected failures from infrastructure problems.
 */
export const InvocationErrorCodes = {
  /** Invocation exceeded the configured timeout */
  TIMEOUT: 'TIMEOUT',
  /** Command execution failed (non-zero exit code) */
  COMMAND_FAILED: 'COMMAND_FAILED',
  /** Agent-specific error during execution */
  AGENT_ERROR: 'AGENT_ERROR',
  /** Error parsing agent output */
  PARSE_ERROR: 'PARSE_ERROR',
} as const;

/** Type for invocation error codes */
export type InvocationErrorCode = typeof InvocationErrorCodes[keyof typeof InvocationErrorCodes];
