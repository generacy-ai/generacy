/**
 * Action handler registry and factory.
 * Provides centralized registration and lookup of action handlers.
 */
import type { ActionHandler, ActionType, StepDefinition } from '../types/index.js';
import { parseActionType } from '../types/action.js';

/**
 * Registry of action handlers by type
 */
const actionRegistry = new Map<ActionType, ActionHandler>();

/**
 * Register an action handler
 * @param handler The action handler to register
 */
export function registerActionHandler(handler: ActionHandler): void {
  if (actionRegistry.has(handler.type)) {
    console.warn(`Overwriting existing handler for action type: ${handler.type}`);
  }
  actionRegistry.set(handler.type, handler);
}

/**
 * Unregister an action handler
 * @param type The action type to unregister
 */
export function unregisterActionHandler(type: ActionType): void {
  actionRegistry.delete(type);
}

/**
 * Get an action handler for a workflow step
 * @param step The workflow step to get a handler for
 * @returns The action handler, or undefined if not found
 */
export function getActionHandler(step: StepDefinition): ActionHandler | undefined {
  const actionType = parseActionType(step);

  // First, check if any registered handler can handle this specific step
  // This allows handlers to have more specific canHandle logic
  for (const handler of actionRegistry.values()) {
    if (handler.canHandle(step)) {
      return handler;
    }
  }

  // Fall back to type-based lookup
  return actionRegistry.get(actionType);
}

/**
 * Get an action handler by type
 * @param type The action type
 * @returns The action handler, or undefined if not found
 */
export function getActionHandlerByType(type: ActionType): ActionHandler | undefined {
  return actionRegistry.get(type);
}

/**
 * Check if a handler is registered for a given action type
 * @param type The action type to check
 * @returns true if a handler is registered
 */
export function hasActionHandler(type: ActionType): boolean {
  return actionRegistry.has(type);
}

/**
 * Get all registered action types
 * @returns Array of registered action types
 */
export function getRegisteredActionTypes(): ActionType[] {
  return Array.from(actionRegistry.keys());
}

/**
 * Clear all registered handlers (useful for testing)
 */
export function clearActionRegistry(): void {
  actionRegistry.clear();
}

/**
 * Get the action type for a workflow step
 * @param step The workflow step
 * @returns The detected action type
 */
export function getActionType(step: StepDefinition): ActionType {
  return parseActionType(step);
}

// Action handlers
import { WorkspacePrepareAction } from './builtin/workspace-prepare.js';
import { AgentInvokeAction } from './builtin/agent-invoke.js';
import { VerificationCheckAction } from './builtin/verification-check.js';
import { PrCreateAction } from './builtin/pr-create.js';
import { ShellAction } from './builtin/shell.js';

/**
 * Register all built-in action handlers
 */
export function registerBuiltinActions(): void {
  registerActionHandler(new WorkspacePrepareAction());
  registerActionHandler(new AgentInvokeAction());
  registerActionHandler(new VerificationCheckAction());
  registerActionHandler(new PrCreateAction());
  registerActionHandler(new ShellAction());
}

// Re-export base action
export { BaseAction } from './base-action.js';

// Re-export action classes
export { WorkspacePrepareAction } from './builtin/workspace-prepare.js';
export { AgentInvokeAction } from './builtin/agent-invoke.js';
export { VerificationCheckAction } from './builtin/verification-check.js';
export { PrCreateAction } from './builtin/pr-create.js';
export { ShellAction } from './builtin/shell.js';

// Re-export CLI utilities
export {
  checkCLI,
  checkAllCLIs,
  executeCommand,
  executeShellCommand,
  parseJSONSafe,
  extractJSON,
  type CommandOptions,
  type CommandResult,
  type CLIStatus,
} from './cli-utils.js';
