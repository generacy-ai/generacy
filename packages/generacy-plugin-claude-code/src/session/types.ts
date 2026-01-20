/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Internal types for session management.
 */

import type {
  SessionState,
  SessionStatus,
  InvokeOptions,
  ContainerConfig,
  QuestionPayload,
  TerminationReason,
} from '../types.js';

// Re-export types needed by consumers
export type {
  SessionState,
  SessionStatus,
  InvokeOptions,
  ContainerConfig,
  QuestionPayload,
  TerminationReason,
};

/**
 * Valid state transitions for sessions.
 * Maps from current state to valid next states.
 */
export const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  created: ['running', 'terminated'],
  running: ['executing', 'awaiting_input', 'terminated'],
  executing: ['running', 'awaiting_input', 'terminated'],
  awaiting_input: ['executing', 'running', 'terminated'],
  terminated: [], // Terminal state - no transitions allowed
};

/**
 * Check if a state transition is valid.
 */
export function isValidTransition(from: SessionStatus, to: SessionStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Events that can trigger state transitions.
 */
export type SessionEvent =
  | { type: 'CONTAINER_STARTED'; containerId: string }
  | { type: 'INVOCATION_STARTED'; invocationId: string }
  | { type: 'INVOCATION_COMPLETED' }
  | { type: 'QUESTION_RECEIVED'; question: QuestionPayload }
  | { type: 'ANSWER_PROVIDED' }
  | { type: 'SESSION_ENDED'; reason: TerminationReason };

/**
 * Internal session data stored by SessionManager.
 */
export interface SessionData {
  /** Unique session identifier */
  id: string;

  /** Current session state */
  state: SessionState;

  /** Container configuration used for this session */
  containerConfig: ContainerConfig;

  /** Docker container ID when running */
  containerId?: string;

  /** Current invocation ID if executing */
  invocationId?: string;

  /** When the session was created */
  createdAt: Date;

  /** When the session was last active */
  lastActiveAt: Date;

  /** Default options for invocations in this session */
  defaultOptions: InvokeOptions;

  /** Pending question if in awaiting_input state */
  pendingQuestion?: QuestionPayload;
}

/**
 * Session creation options.
 */
export interface CreateSessionOptions {
  /** Container configuration */
  containerConfig: ContainerConfig;

  /** Default invocation options */
  defaultOptions?: InvokeOptions;
}

/**
 * Session update options for partial updates.
 */
export interface UpdateSessionOptions {
  /** Update container ID */
  containerId?: string;

  /** Update invocation ID */
  invocationId?: string;

  /** Update pending question */
  pendingQuestion?: QuestionPayload | null;

  /** Update default options */
  defaultOptions?: InvokeOptions;
}

/**
 * Session summary for external visibility.
 */
export interface SessionSummary {
  /** Session ID */
  id: string;

  /** Current status */
  status: SessionStatus;

  /** Whether the session is active (not terminated) */
  isActive: boolean;

  /** Container ID if available */
  containerId?: string;

  /** Creation time */
  createdAt: Date;

  /** Last activity time */
  lastActiveAt: Date;
}

/**
 * Default session timeout in milliseconds (1 hour).
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 3600000;

/**
 * Default invocation options.
 */
export const DEFAULT_INVOKE_OPTIONS: InvokeOptions = {
  timeout: 300000, // 5 minutes
};
