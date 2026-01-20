/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Internal types for invocation management.
 */

import type {
  InvokeParams,
  InvokeOptions,
  InvocationResult,
  OutputChunk,
} from '../types.js';

// Re-export types needed by consumers
export type {
  InvokeParams,
  InvokeOptions,
  InvocationResult,
  OutputChunk,
};

/**
 * Internal state of an invocation.
 */
export type InvocationState =
  | { status: 'pending' }
  | { status: 'executing'; startedAt: Date }
  | { status: 'awaiting_input'; question: string }
  | { status: 'completed'; result: InvocationResult }
  | { status: 'failed'; error: Error };

/**
 * Invocation status type.
 */
export type InvocationStatus = InvocationState['status'];

/**
 * Internal invocation tracking data.
 */
export interface InvocationData {
  /** Unique invocation identifier */
  id: string;

  /** Session ID this invocation belongs to */
  sessionId: string;

  /** The prompt being executed */
  prompt: string;

  /** Options for this invocation */
  options: InvokeOptions;

  /** Current state */
  state: InvocationState;

  /** Output chunks collected during execution */
  outputChunks: OutputChunk[];

  /** When the invocation was created */
  createdAt: Date;

  /** When the invocation completed (if completed) */
  completedAt?: Date;

  /** Files modified during invocation */
  filesModified: string[];
}

/**
 * Options for executing a command in the container.
 */
export interface ExecuteOptions {
  /** Working directory for the command */
  workdir?: string;

  /** Environment variables to set */
  env?: Record<string, string>;

  /** Timeout in milliseconds */
  timeout?: number;

  /** Callback for output chunks */
  onOutput?: (chunk: OutputChunk) => void;
}

/**
 * Command builder options for Claude Code CLI.
 */
export interface CommandBuilderOptions {
  /** The prompt to execute */
  prompt: string;

  /** Use headless mode (no interactive terminal) */
  headless?: boolean;

  /** Output format (json for structured output) */
  outputFormat?: 'json' | 'text';

  /** Tool whitelist */
  tools?: string[];

  /** Additional context to pass */
  context?: string;

  /** Working directory */
  workdir?: string;

  /** Resume session ID (for continuing previous session) */
  resumeSession?: string;

  /** Maximum turns/iterations */
  maxTurns?: number;

  /** Print output mode */
  print?: 'all' | 'assistant' | 'none';
}

/**
 * Result of command execution.
 */
export interface CommandResult {
  /** Exit code from the command */
  exitCode: number;

  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;

  /** Parsed output chunks */
  chunks: OutputChunk[];

  /** Duration in milliseconds */
  duration: number;
}

/**
 * Mode setting options.
 */
export interface SetModeOptions {
  /** The mode to set */
  mode: string;

  /** Timeout for mode setting command */
  timeout?: number;
}

/**
 * Default invocation timeout (5 minutes).
 */
export const DEFAULT_INVOCATION_TIMEOUT_MS = 300000;

/**
 * Default max turns for Claude Code.
 */
export const DEFAULT_MAX_TURNS = 100;

/**
 * Build the Claude Code command array.
 */
export function buildClaudeCommand(options: CommandBuilderOptions): string[] {
  const cmd = ['claude'];

  // Headless mode for non-interactive execution
  if (options.headless !== false) {
    cmd.push('--headless');
  }

  // Output format
  if (options.outputFormat === 'json') {
    cmd.push('--output', 'json');
  }

  // Print mode
  if (options.print) {
    cmd.push('--print', options.print);
  }

  // Max turns
  if (options.maxTurns) {
    cmd.push('--max-turns', String(options.maxTurns));
  }

  // Tool whitelist
  if (options.tools && options.tools.length > 0) {
    cmd.push('--allowedTools', options.tools.join(','));
  }

  // Resume session
  if (options.resumeSession) {
    cmd.push('--resume', options.resumeSession);
  }

  // Working directory
  if (options.workdir) {
    cmd.push('--cwd', options.workdir);
  }

  // Prompt (must be last)
  cmd.push('--prompt', options.prompt);

  return cmd;
}

/**
 * Build the Agency mode set command.
 */
export function buildModeCommand(mode: string): string[] {
  return ['agency', 'mode', 'set', mode];
}
