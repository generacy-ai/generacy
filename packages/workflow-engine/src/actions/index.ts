/**
 * Action handler registry and factory.
 * Provides centralized registration and lookup of action handlers.
 * Supports both single handler registration and namespace-based registration.
 */
import type { ActionHandler, ActionType, ActionIdentifier, ActionNamespace, StepDefinition } from '../types/index.js';
import { parseActionType, isNamespacedAction, parseNamespacedAction } from '../types/action.js';

/**
 * Registry of action handlers by type (supports both flat and namespaced)
 */
const actionRegistry = new Map<ActionIdentifier, ActionHandler>();

/**
 * Registry of namespaces for organization
 */
const namespaceRegistry = new Map<string, ActionNamespace>();

/**
 * Register an action handler
 * @param handler The action handler to register
 */
export function registerActionHandler(handler: ActionHandler): void {
  if (actionRegistry.has(handler.type)) {
    console.warn(`Overwriting existing handler for action type: ${handler.type}`);
  }
  actionRegistry.set(handler.type, handler);

  // Also register in namespace if it's a namespaced action
  const parsed = parseNamespacedAction(handler.type);
  if (parsed) {
    let ns = namespaceRegistry.get(parsed.namespace);
    if (!ns) {
      ns = { namespace: parsed.namespace, handlers: [] };
      namespaceRegistry.set(parsed.namespace, ns);
    }
    // Add if not already present
    if (!ns.handlers.some(h => h.type === handler.type)) {
      ns.handlers.push(handler);
    }
  }
}

/**
 * Register a namespace of action handlers
 * @param namespace The namespace definition with handlers
 */
export function registerNamespace(namespace: ActionNamespace): void {
  // Store the namespace
  const existing = namespaceRegistry.get(namespace.namespace);
  if (existing) {
    // Merge handlers
    for (const handler of namespace.handlers) {
      if (!existing.handlers.some(h => h.type === handler.type)) {
        existing.handlers.push(handler);
      }
      // Also register individually
      actionRegistry.set(handler.type, handler);
    }
    if (namespace.description && !existing.description) {
      existing.description = namespace.description;
    }
  } else {
    namespaceRegistry.set(namespace.namespace, namespace);
    // Register all handlers individually as well
    for (const handler of namespace.handlers) {
      actionRegistry.set(handler.type, handler);
    }
  }
}

/**
 * Unregister an action handler
 * @param type The action type to unregister
 */
export function unregisterActionHandler(type: ActionIdentifier): void {
  actionRegistry.delete(type);

  // Also remove from namespace
  const parsed = parseNamespacedAction(type);
  if (parsed) {
    const ns = namespaceRegistry.get(parsed.namespace);
    if (ns) {
      ns.handlers = ns.handlers.filter(h => h.type !== type);
    }
  }
}

/**
 * Unregister an entire namespace
 * @param namespace The namespace to unregister
 */
export function unregisterNamespace(namespace: string): void {
  const ns = namespaceRegistry.get(namespace);
  if (ns) {
    // Remove all handlers in the namespace
    for (const handler of ns.handlers) {
      actionRegistry.delete(handler.type);
    }
    namespaceRegistry.delete(namespace);
  }
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
 * @param type The action type or identifier
 * @returns The action handler, or undefined if not found
 */
export function getActionHandlerByType(type: ActionIdentifier): ActionHandler | undefined {
  return actionRegistry.get(type);
}

/**
 * Get an action handler by namespace and name
 * @param namespace The namespace (e.g., 'github')
 * @param name The action name (e.g., 'preflight')
 * @returns The action handler, or undefined if not found
 */
export function getActionHandlerByNamespace(namespace: string, name: string): ActionHandler | undefined {
  return actionRegistry.get(`${namespace}.${name}`);
}

/**
 * Check if a handler is registered for a given action type
 * @param type The action type to check
 * @returns true if a handler is registered
 */
export function hasActionHandler(type: ActionIdentifier): boolean {
  return actionRegistry.has(type);
}

/**
 * Check if a namespace is registered
 * @param namespace The namespace to check
 * @returns true if the namespace is registered
 */
export function hasNamespace(namespace: string): boolean {
  return namespaceRegistry.has(namespace);
}

/**
 * Get all registered action types
 * @returns Array of registered action types/identifiers
 */
export function getRegisteredActionTypes(): ActionIdentifier[] {
  return Array.from(actionRegistry.keys());
}

/**
 * Get all registered namespaces
 * @returns Array of registered namespace names
 */
export function getRegisteredNamespaces(): string[] {
  return Array.from(namespaceRegistry.keys());
}

/**
 * Get a namespace definition
 * @param namespace The namespace name
 * @returns The namespace definition, or undefined
 */
export function getNamespace(namespace: string): ActionNamespace | undefined {
  return namespaceRegistry.get(namespace);
}

/**
 * Get all handlers in a namespace
 * @param namespace The namespace name
 * @returns Array of handlers in the namespace
 */
export function getNamespaceHandlers(namespace: string): ActionHandler[] {
  return namespaceRegistry.get(namespace)?.handlers ?? [];
}

/**
 * Clear all registered handlers (useful for testing)
 */
export function clearActionRegistry(): void {
  actionRegistry.clear();
  namespaceRegistry.clear();
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
import { HumancyReviewAction } from './builtin/humancy-review.js';
import { SpecKitAction } from './builtin/speckit/index.js';

// Namespace imports
import { githubNamespace } from './github/index.js';
import { workflowNamespace } from './workflow/index.js';
import { epicNamespace } from './epic/index.js';

/**
 * Register all built-in action handlers
 */
export function registerBuiltinActions(): void {
  // Register legacy/built-in handlers
  registerActionHandler(new WorkspacePrepareAction());
  registerActionHandler(new AgentInvokeAction());
  registerActionHandler(new VerificationCheckAction());
  registerActionHandler(new PrCreateAction());
  registerActionHandler(new ShellAction());
  registerActionHandler(new HumancyReviewAction());
  registerActionHandler(new SpecKitAction());

  // Register namespaced action handlers
  registerNamespace(githubNamespace);
  registerNamespace(workflowNamespace);
  registerNamespace(epicNamespace);
}

// Re-export base action
export { BaseAction } from './base-action.js';

// Re-export action classes
export { WorkspacePrepareAction } from './builtin/workspace-prepare.js';
export { AgentInvokeAction } from './builtin/agent-invoke.js';
export { VerificationCheckAction } from './builtin/verification-check.js';
export { PrCreateAction } from './builtin/pr-create.js';
export { ShellAction } from './builtin/shell.js';
export { HumancyReviewAction, type HumanDecisionHandler } from './builtin/humancy-review.js';
export { SpecKitAction } from './builtin/speckit/index.js';
export * from './builtin/speckit/types.js';

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

// Re-export namespaces
export { githubNamespace, githubActionHandlers } from './github/index.js';
export { workflowNamespace, workflowActionHandlers } from './workflow/index.js';
export { epicNamespace, epicActionHandlers } from './epic/index.js';
