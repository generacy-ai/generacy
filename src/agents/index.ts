/**
 * Agent abstraction layer for invoking AI coding agents.
 *
 * Provides a unified interface for the workflow orchestrator to execute
 * commands through different agent platforms (Claude Code, Copilot, Cursor).
 */

// Types
export {
  AgentFeature,
  type AgentInvoker,
  type InvocationConfig,
  type InvocationContext,
  type InvocationResult,
  type ToolCallRecord,
  type InvocationError,
} from './types.js';

// Errors
export {
  AgentUnavailableError,
  AgentInitializationError,
  AgentNotFoundError,
  DefaultAgentNotConfiguredError,
  AgentExistsError,
  InvocationErrorCodes,
} from './errors.js';

// Registry
export { AgentRegistry } from './agent-registry.js';

// Built-in agents
export { ClaudeCodeInvoker } from './claude-code-invoker.js';
