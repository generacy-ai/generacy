/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Claude Code agent platform plugin for Generacy.
 * Provides a thin interface for invoking Claude Code agents in isolated Docker containers.
 */

// Core types
export type {
  // Session types
  Session,
  SessionStatus,
  SessionState,
  TerminationReason,
  InternalSession,
  // Container types
  ContainerConfig,
  Mount,
  ResourceLimits,
  // Invocation types
  InvokeParams,
  InvokeOptions,
  InvocationResult,
  // Output types
  OutputChunk,
  OutputChunkType,
  OutputMetadata,
  UrgencyLevel,
  QuestionPayload,
  // Error types
  InvocationError,
  ErrorCode,
  // Plugin interface
  ClaudeCodePluginInterface,
} from './types.js';

// Type guards
export {
  isQuestionChunk,
  isErrorChunk,
  isSessionRunning,
  isSessionTerminated,
} from './types.js';

// Validation schemas
export {
  MountSchema,
  ResourceLimitsSchema,
  ContainerConfigSchema,
  InvokeOptionsSchema,
  InvokeParamsSchema,
} from './schemas.js';

// Error classes
export {
  PluginError,
  SessionNotFoundError,
  SessionInvalidStateError,
  ContainerStartError,
  ContainerNotRunningError,
  InvocationTimeoutError,
  InvocationFailedError,
  isPluginError,
  wrapError,
} from './errors.js';

// Plugin class and options
export { ClaudeCodePlugin } from './plugin/claude-code-plugin.js';
export type { ClaudeCodePluginOptions } from './plugin/claude-code-plugin.js';

// Streaming utilities
export {
  createOutputStream,
  createOutputStreamFromData,
  collectOutputChunks,
  findQuestion,
  filterChunksByType,
  waitForCompletion,
} from './streaming/output-stream.js';

// Output parser
export { OutputParser } from './streaming/output-parser.js';

// Invocation utilities
export {
  buildClaudeCommand,
  buildModeCommand,
  DEFAULT_INVOCATION_TIMEOUT_MS,
  DEFAULT_MAX_TURNS,
} from './invocation/types.js';
