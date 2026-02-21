/**
 * Workflow registry — global singleton for plugin-provided workflow discovery.
 * Provides centralized registration and lookup of workflow file paths by name.
 * Follows the same pattern as the actionRegistry in actions/index.ts.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Registry of workflow names to absolute file paths.
 */
const workflowRegistry = new Map<string, string>();

/**
 * Register a workflow by name.
 * Validates that the file exists at registration time.
 * Logs a warning if overwriting an existing registration.
 *
 * @param name The workflow name (e.g., 'speckit-feature')
 * @param filePath The absolute path to the workflow YAML file
 * @throws Error if filePath does not exist on disk
 */
export function registerWorkflow(name: string, filePath: string): void {
  const absolutePath = resolve(filePath);

  if (!existsSync(absolutePath)) {
    throw new Error(
      `Cannot register workflow "${name}": file not found at ${absolutePath}`
    );
  }

  if (workflowRegistry.has(name)) {
    console.warn(`Overwriting existing workflow registration: ${name}`);
  }

  workflowRegistry.set(name, absolutePath);
}

/**
 * Register multiple workflows at once.
 * Each entry is validated and registered individually.
 *
 * @param workflows A Map or Record of workflow name → file path
 */
export function registerWorkflows(workflows: Map<string, string> | Record<string, string>): void {
  const entries = workflows instanceof Map
    ? workflows.entries()
    : Object.entries(workflows);

  for (const [name, filePath] of entries) {
    registerWorkflow(name, filePath);
  }
}

/**
 * Resolve a workflow name to a file path from the registry.
 *
 * @param name The workflow name to look up
 * @returns The absolute file path, or undefined if not registered
 */
export function resolveRegisteredWorkflow(name: string): string | undefined {
  return workflowRegistry.get(name);
}

/**
 * Check if a workflow is registered.
 *
 * @param name The workflow name to check
 * @returns true if a workflow is registered under this name
 */
export function hasRegisteredWorkflow(name: string): boolean {
  return workflowRegistry.has(name);
}

/**
 * Get all registered workflow names.
 *
 * @returns Array of registered workflow names
 */
export function getRegisteredWorkflowNames(): string[] {
  return Array.from(workflowRegistry.keys());
}

/**
 * Clear the workflow registry. Useful for testing.
 */
export function clearWorkflowRegistry(): void {
  workflowRegistry.clear();
}
