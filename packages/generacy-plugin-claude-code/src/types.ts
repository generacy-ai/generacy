/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Core type definitions for Claude Code agent integration.
 */

// =============================================================================
// Session Types
// =============================================================================

/**
 * Represents an active agent session.
 */
export interface Session {
  /** Unique session identifier */
  readonly id: string;

  /** Current session status */
  readonly status: SessionStatus;

  /** When the session was created */
  readonly createdAt: Date;

  /** When the session was last active */
  readonly lastActiveAt: Date;
}

export type SessionStatus =
  | 'created'
  | 'running'
  | 'executing'
  | 'awaiting_input'
  | 'terminated';

/**
 * Internal session state with full state machine representation.
 */
export type SessionState =
  | { status: 'created' }
  | { status: 'running'; containerId: string }
  | { status: 'executing'; invocationId: string; containerId: string }
  | { status: 'awaiting_input'; question: QuestionPayload; containerId: string }
  | { status: 'terminated'; reason: TerminationReason };

export type TerminationReason =
  | 'user_requested'
  | 'timeout'
  | 'container_crashed'
  | 'error';

/**
 * Internal session representation with full state.
 */
export interface InternalSession {
  /** Unique session identifier */
  id: string;

  /** Current session state */
  state: SessionState;

  /** Container configuration used for this session */
  containerConfig: ContainerConfig;

  /** Docker container ID when running */
  containerId?: string;

  /** When the session was created */
  createdAt: Date;

  /** When the session was last active */
  lastActiveAt: Date;

  /** Default options for invocations in this session */
  defaultOptions: InvokeOptions;
}

// =============================================================================
// Container Configuration
// =============================================================================

/**
 * Configuration for the Docker container running the agent.
 */
export interface ContainerConfig {
  /** Docker image to use (e.g., 'generacy/dev-container:latest') */
  image: string;

  /** Working directory inside the container */
  workdir: string;

  /** Environment variables to set */
  env: Record<string, string>;

  /** Volume mounts */
  mounts: Mount[];

  /** Docker network name */
  network: string;

  /** Optional resource limits */
  resources?: ResourceLimits;
}

export interface Mount {
  /** Host path or volume name */
  source: string;

  /** Container path */
  target: string;

  /** Mount as read-only */
  readonly?: boolean;
}

export interface ResourceLimits {
  /** Memory limit in bytes */
  memory?: number;

  /** CPU quota (e.g., 1.5 for 1.5 CPUs) */
  cpus?: number;
}

// =============================================================================
// Invocation Types
// =============================================================================

/**
 * Parameters for invoking Claude Code.
 */
export interface InvokeParams {
  /** The prompt to send to the agent */
  prompt: string;

  /** Optional session ID for session-based invocation */
  sessionId?: string;

  /** Optional overrides for invoke options */
  options?: Partial<InvokeOptions>;
}

/**
 * Options that control invocation behavior.
 */
export interface InvokeOptions {
  /** Agency mode to set before invocation */
  mode?: string;

  /** Maximum execution time in milliseconds (default: 300000) */
  timeout?: number;

  /** Tool whitelist (empty array = all tools allowed) */
  tools?: string[];

  /** Serialized context for workflow continuity */
  context?: string;

  /** Associated GitHub issue number */
  issueNumber?: number;
}

/**
 * Result of a completed invocation.
 */
export interface InvocationResult {
  /** Whether the invocation completed successfully */
  success: boolean;

  /** Session ID used for this invocation */
  sessionId: string;

  /** Unique invocation identifier */
  invocationId: string;

  /** Exit code from Claude Code process */
  exitCode: number;

  /** Summary of what was accomplished (if available) */
  summary?: string;

  /** Files that were modified during invocation */
  filesModified?: string[];

  /** Duration in milliseconds */
  duration: number;

  /** Error details if invocation failed */
  error?: InvocationError;
}

// =============================================================================
// Output Streaming Types
// =============================================================================

/**
 * A chunk of output from the agent.
 */
export interface OutputChunk {
  /** Type of output chunk */
  type: OutputChunkType;

  /** When this chunk was received */
  timestamp: Date;

  /** Type-specific payload */
  data: unknown;

  /** Optional metadata */
  metadata?: OutputMetadata;
}

export type OutputChunkType =
  | 'stdout'
  | 'stderr'
  | 'tool_call'
  | 'tool_result'
  | 'question'
  | 'complete'
  | 'error';

export interface OutputMetadata {
  /** Tool name for tool_call/tool_result chunks */
  toolName?: string;

  /** File path for file-related operations */
  filePath?: string;

  /** Whether the operation succeeded (for tool_result) */
  isSuccess?: boolean;

  /** Urgency level for question chunks */
  urgency?: UrgencyLevel;
}

/**
 * Urgency levels for human decision questions.
 * Maps to Humancy decision framework urgency levels.
 */
export type UrgencyLevel = 'blocking_now' | 'blocking_soon' | 'when_available';

/**
 * Payload for question chunks requiring human input.
 */
export interface QuestionPayload {
  /** The question text */
  question: string;

  /** How urgently the answer is needed */
  urgency: UrgencyLevel;

  /** Optional predefined choices */
  choices?: string[];

  /** Additional context for the question */
  context?: string;

  /** When the question was asked */
  askedAt: Date;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Detailed error information for failed invocations.
 */
export interface InvocationError {
  /** Error classification code */
  code: ErrorCode;

  /** Whether this error is transient (retryable) */
  isTransient: boolean;

  /** Human-readable error message */
  message: string;

  /** Additional error context */
  context?: unknown;
}

/**
 * Error classification codes.
 */
export type ErrorCode =
  | 'CONTAINER_CRASHED'
  | 'API_TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'UNKNOWN';

// =============================================================================
// Plugin Interface
// =============================================================================

/**
 * Main plugin interface for Claude Code agent invocation.
 */
export interface ClaudeCodePluginInterface {
  /**
   * Invoke Claude Code with parameters.
   * Creates an ephemeral session if no sessionId provided.
   */
  invoke(params: InvokeParams): Promise<InvocationResult>;

  /**
   * Convenience method for simple prompt invocation.
   */
  invokeWithPrompt(prompt: string, options?: InvokeOptions): Promise<InvocationResult>;

  /**
   * Start a new session with the given container configuration.
   */
  startSession(container: ContainerConfig): Promise<Session>;

  /**
   * Continue an existing session with a new prompt.
   * Used to provide answers to questions.
   */
  continueSession(sessionId: string, prompt: string): Promise<InvocationResult>;

  /**
   * End a session and clean up resources.
   */
  endSession(sessionId: string): Promise<void>;

  /**
   * Stream output from an active session.
   * Yields OutputChunks as they are received from the agent.
   */
  streamOutput(sessionId: string): AsyncIterable<OutputChunk>;

  /**
   * Set the Agency mode for a session.
   * Must be called before invoke for mode to take effect.
   */
  setMode(sessionId: string, mode: string): Promise<void>;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard for question chunks.
 */
export function isQuestionChunk(chunk: OutputChunk): chunk is OutputChunk & {
  type: 'question';
  data: QuestionPayload;
} {
  return chunk.type === 'question' && chunk.data !== null;
}

/**
 * Type guard for error chunks.
 */
export function isErrorChunk(chunk: OutputChunk): chunk is OutputChunk & {
  type: 'error';
  data: { message: string; code?: string };
} {
  return chunk.type === 'error';
}

/**
 * Type guard for running session state.
 */
export function isSessionRunning(state: SessionState): state is SessionState & {
  status: 'running' | 'executing' | 'awaiting_input';
  containerId: string;
} {
  return ['running', 'executing', 'awaiting_input'].includes(state.status);
}

/**
 * Type guard for terminated session state.
 */
export function isSessionTerminated(state: SessionState): state is SessionState & {
  status: 'terminated';
  reason: TerminationReason;
} {
  return state.status === 'terminated';
}
