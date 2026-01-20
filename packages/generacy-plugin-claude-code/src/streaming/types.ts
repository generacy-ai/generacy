/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Internal types for output streaming.
 */

import type {
  OutputChunk,
  OutputChunkType,
  OutputMetadata,
  UrgencyLevel,
  QuestionPayload,
} from '../types.js';

// Re-export types needed by consumers
export type {
  OutputChunk,
  OutputChunkType,
  OutputMetadata,
  UrgencyLevel,
  QuestionPayload,
};

/**
 * Raw output line from Claude Code JSON output.
 * This represents the structure of each JSON line from `claude --output json`.
 */
export interface RawClaudeOutput {
  /** Type of the output message */
  type: RawOutputType;

  /** Timestamp of the output (ISO string) */
  timestamp?: string;

  /** Content varies by type */
  content?: unknown;

  /** Tool name for tool-related messages */
  tool?: string;

  /** Tool input for tool calls */
  input?: unknown;

  /** Tool result for tool results */
  result?: unknown;

  /** Error message if type is error */
  error?: string;

  /** Exit code for completion */
  exit_code?: number;

  /** File path for file-related operations */
  file?: string;

  /** Question text for assistant messages that ask questions */
  question?: string;

  /** Whether the message is a question */
  is_question?: boolean;

  /** Urgency level for questions */
  urgency?: string;

  /** Choices for questions */
  choices?: string[];
}

/**
 * Raw output types from Claude Code.
 */
export type RawOutputType =
  | 'system'
  | 'assistant'
  | 'user'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'result'
  | 'status';

/**
 * Parser state for tracking multi-line content.
 */
export interface ParserState {
  /** Buffer for incomplete JSON lines */
  buffer: string;

  /** Whether we're currently in a tool execution context */
  inToolExecution: boolean;

  /** Current tool name if in tool execution */
  currentToolName?: string;

  /** Accumulated output for current context */
  accumulatedOutput: string[];
}

/**
 * Output stream options.
 */
export interface OutputStreamOptions {
  /** Whether to include raw stdout/stderr chunks */
  includeRaw?: boolean;

  /** Whether to parse tool calls and results */
  parseTools?: boolean;

  /** Custom question detector function */
  questionDetector?: (content: string) => QuestionPayload | null;
}

/**
 * Output event emitted by the stream.
 */
export interface OutputEvent {
  /** The parsed output chunk */
  chunk: OutputChunk;

  /** Raw line that produced this chunk (if available) */
  rawLine?: string;
}

/**
 * Map from raw output type to output chunk type.
 */
export const OUTPUT_TYPE_MAP: Record<RawOutputType, OutputChunkType> = {
  system: 'stdout',
  assistant: 'stdout',
  user: 'stdout',
  tool_use: 'tool_call',
  tool_result: 'tool_result',
  error: 'error',
  result: 'complete',
  status: 'stdout',
};

/**
 * Map urgency strings to UrgencyLevel.
 */
export function parseUrgency(urgency?: string): UrgencyLevel {
  switch (urgency?.toLowerCase()) {
    case 'blocking_now':
    case 'high':
    case 'urgent':
      return 'blocking_now';
    case 'blocking_soon':
    case 'medium':
      return 'blocking_soon';
    case 'when_available':
    case 'low':
    default:
      return 'when_available';
  }
}

/**
 * Default parser state.
 */
export function createInitialParserState(): ParserState {
  return {
    buffer: '',
    inToolExecution: false,
    accumulatedOutput: [],
  };
}
