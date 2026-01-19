/**
 * Core types for the agent invocation abstraction layer.
 */

/** Feature capabilities that agents may support */
export enum AgentFeature {
  /** Streaming output support */
  Streaming = 'streaming',
  /** MCP tool support */
  McpTools = 'mcp_tools',
}

/** Context for an agent invocation */
export interface InvocationContext {
  /** Working directory for the invocation */
  workingDirectory: string;
  /** Additional environment variables */
  environment?: Record<string, string>;
  /** Mode to run the agent in (flows through context, not global state) */
  mode?: string;
  /** Issue number for context */
  issueNumber?: number;
  /** Git branch for context */
  branch?: string;
}

/** Configuration for an agent invocation */
export interface InvocationConfig {
  /** Command to execute (e.g., "/speckit:specify") */
  command: string;
  /** Execution context */
  context: InvocationContext;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Whether to stream output */
  streaming?: boolean;
}

/** Record of a tool call made during invocation */
export interface ToolCallRecord {
  /** Name of the tool that was called */
  toolName: string;
  /** Whether the tool call succeeded */
  success: boolean;
  /** Duration of the tool call in milliseconds */
  duration: number;
  /** When the tool call was made */
  timestamp: Date;
  /** Summary of the input (truncated on success, detailed on failure) */
  inputSummary?: string;
  /** Summary of the output */
  outputSummary?: string;
  /** Error message if the tool call failed */
  errorMessage?: string;
}

/** Error details for failed invocations */
export interface InvocationError {
  /** Error code (e.g., 'TIMEOUT', 'COMMAND_FAILED') */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Additional error details */
  details?: unknown;
}

/** Result of an agent invocation */
export interface InvocationResult {
  /** Whether the invocation succeeded */
  success: boolean;
  /** Combined output from stdout and stderr */
  output: string;
  /** Process exit code (if applicable) */
  exitCode?: number;
  /** Duration of the invocation in milliseconds */
  duration: number;
  /** Tool calls made during the invocation */
  toolCalls?: ToolCallRecord[];
  /** Error details when success=false */
  error?: InvocationError;
}

/**
 * Agent invoker interface - strategy pattern for different agents.
 *
 * Implementations:
 * - ClaudeCodeInvoker (built-in)
 * - Copilot (plugin)
 * - Cursor (plugin)
 */
export interface AgentInvoker {
  /** Unique name for this agent (e.g., "claude-code", "copilot") */
  readonly name: string;

  /**
   * Check if this agent supports a specific feature.
   * @param feature The feature to check
   * @returns true if the feature is supported
   */
  supports(feature: AgentFeature): boolean;

  /**
   * Check if this agent is available in the current environment.
   * @returns true if the agent can be used
   */
  isAvailable(): Promise<boolean>;

  /**
   * Initialize the agent. Must be called before invoke().
   * @throws AgentInitializationError if initialization fails
   */
  initialize(): Promise<void>;

  /**
   * Invoke the agent with the given configuration.
   * @param config Invocation configuration
   * @returns Invocation result (success=false for invocation failures)
   * @throws AgentUnavailableError for infrastructure errors
   */
  invoke(config: InvocationConfig): Promise<InvocationResult>;

  /**
   * Shutdown the agent and release resources.
   */
  shutdown(): Promise<void>;
}
