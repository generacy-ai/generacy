/**
 * Claude Code-specific launch intent types.
 *
 * These intents are handled by ClaudeCodeLaunchPlugin and represent
 * the three ways Claude CLI is invoked: phase execution, PR feedback,
 * and interactive conversation turns.
 */

/**
 * Intent for executing a speckit workflow phase via Claude CLI.
 * Excludes 'validate' at compile time — validate runs via GenericSubprocessPlugin.
 */
export interface PhaseIntent {
  kind: 'phase';
  /** Speckit phase to execute */
  phase: 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement';
  /** Full prompt text: slash command + issue URL (composed by caller) */
  prompt: string;
  /** Resume a previous Claude session (for MCP server warmth + context carry) */
  sessionId?: string;
}

/**
 * Intent for addressing PR review feedback via Claude CLI.
 */
export interface PrFeedbackIntent {
  kind: 'pr-feedback';
  /** PR number for logging/tracing */
  prNumber: number;
  /** Full prompt text (pre-built by caller via buildFeedbackPrompt()) */
  prompt: string;
}

/**
 * Intent for a single interactive conversation turn via PTY-wrapped Claude CLI.
 */
export interface ConversationTurnIntent {
  kind: 'conversation-turn';
  /** User message to send */
  message: string;
  /** Resume session ID (omit for first turn) */
  sessionId?: string;
  /** Model override (omit for CLI default) */
  model?: string;
  /** Whether to skip permission prompts */
  skipPermissions: boolean;
}

/**
 * Union of all Claude Code-specific intent types.
 */
export type ClaudeCodeIntent = PhaseIntent | PrFeedbackIntent | ConversationTurnIntent;
