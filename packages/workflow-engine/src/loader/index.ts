/**
 * Workflow YAML loader.
 * Loads and parses workflow definition files.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateWorkflow, WorkflowValidationError } from './validator.js';
import { mergeWorkflows } from './extends.js';
import { BaseWorkflowNotFoundError } from '../errors/base-workflow-not-found.js';
import { CircularExtendsError } from '../errors/circular-extends.js';
import { WorkflowOverrideError } from '../errors/workflow-override.js';
import type { WorkflowDefinition } from '../types/workflow.js';
import type { ExecutableWorkflow } from '../types/execution.js';

/**
 * Resolves a workflow name to a file path.
 * Used by `loadWorkflowWithExtends` to find base workflows.
 *
 * @param name - The workflow name or path to resolve
 * @param excludePath - Optional file path to exclude from resolution (prevents self-resolution)
 * @returns The resolved absolute file path
 * @throws BaseWorkflowNotFoundError if the workflow cannot be found
 */
export type WorkflowResolver = (name: string, excludePath?: string) => string;

/**
 * Load a workflow from a YAML file
 * @param filePath Path to the workflow YAML file
 * @returns Parsed and validated WorkflowDefinition
 * @throws Error if file cannot be read or validation fails
 */
export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  // Read file content
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Workflow file not found: ${filePath}`);
    }
    throw new Error(`Failed to read workflow file: ${(error as Error).message}`);
  }

  // Parse YAML
  let data: unknown;
  try {
    data = parseYaml(content);
  } catch (error) {
    throw new Error(`Failed to parse workflow YAML: ${(error as Error).message}`);
  }

  // Validate and return
  return validateWorkflow(data);
}

/**
 * Load a workflow from a YAML string
 * @param content YAML content string
 * @returns Parsed and validated WorkflowDefinition
 */
export function loadWorkflowFromString(content: string): WorkflowDefinition {
  // Parse YAML
  let data: unknown;
  try {
    data = parseYaml(content);
  } catch (error) {
    throw new Error(`Failed to parse workflow YAML: ${(error as Error).message}`);
  }

  // Validate and return
  return validateWorkflow(data);
}

/**
 * Convert a WorkflowDefinition to an ExecutableWorkflow
 * @param definition The workflow definition
 * @param inputs Runtime input values
 * @param env Additional environment variables
 * @returns ExecutableWorkflow ready for execution
 */
export function prepareWorkflow(
  definition: WorkflowDefinition,
  inputs?: Record<string, unknown>,
  env?: Record<string, string>
): ExecutableWorkflow {
  // Merge environment variables
  const mergedEnv: Record<string, string> = {
    ...definition.env,
    ...env,
  };

  // Resolve input defaults
  const resolvedInputs: Record<string, unknown> = {};
  if (definition.inputs) {
    for (const inputDef of definition.inputs) {
      const value = inputs?.[inputDef.name] ?? inputDef.default;
      if (inputDef.required && value === undefined) {
        throw new Error(`Required input missing: ${inputDef.name}`);
      }
      if (value !== undefined) {
        resolvedInputs[inputDef.name] = value;
      }
    }
  }

  // Also include any inputs not defined in the schema
  if (inputs) {
    for (const [key, value] of Object.entries(inputs)) {
      if (!(key in resolvedInputs)) {
        resolvedInputs[key] = value;
      }
    }
  }

  return {
    name: definition.name,
    description: definition.description,
    phases: definition.phases,
    env: mergedEnv,
    timeout: definition.timeout,
  };
}

/**
 * Load a workflow with `extends` inheritance support.
 *
 * Uses two-pass validation:
 *   1. Parse YAML loosely (no schema validation)
 *   2. If `extends` present, resolve base, recurse, merge
 *   3. Validate final merged result against WorkflowDefinitionSchema
 *
 * @param filePath - Path to the workflow YAML file
 * @param resolver - Function to resolve workflow names to file paths
 * @param _seen - Internal: set of resolved file paths for circular detection
 * @returns Parsed, merged, and validated WorkflowDefinition
 */
export async function loadWorkflowWithExtends(
  filePath: string,
  resolver: WorkflowResolver,
  _seen?: Set<string>,
): Promise<WorkflowDefinition> {
  const resolvedPath = resolve(filePath);

  // Circular detection
  const seen = _seen ?? new Set<string>();
  if (seen.has(resolvedPath)) {
    throw new CircularExtendsError([...seen, resolvedPath]);
  }
  seen.add(resolvedPath);

  // Read and parse YAML loosely (no schema validation yet)
  let content: string;
  try {
    content = await readFile(resolvedPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Workflow file not found: ${resolvedPath}`);
    }
    throw new Error(`Failed to read workflow file: ${(error as Error).message}`);
  }

  let data: Record<string, unknown>;
  try {
    data = parseYaml(content) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to parse workflow YAML: ${(error as Error).message}`);
  }

  // Validate: `overrides` without `extends` is always a mistake
  if (data.overrides && !data.extends) {
    throw new WorkflowOverrideError(
      '"overrides" block requires "extends" — cannot use overrides without a base workflow.',
    );
  }

  // Validate: `extends` + both `phases` and `overrides.phases` is ambiguous
  if (data.extends && data.phases && (data.overrides as Record<string, unknown> | undefined)?.phases) {
    throw new WorkflowOverrideError(
      'Cannot specify both "phases" and "overrides.phases" when using "extends" — use "phases" for full replacement or "overrides.phases" for selective override, not both.',
    );
  }

  // No extends: validate with existing path and return
  if (!data.extends) {
    return validateWorkflow(data);
  }

  // Resolve the base workflow
  const extendsName = data.extends as string;
  let basePath: string;
  try {
    basePath = resolver(extendsName, resolvedPath);
  } catch (error) {
    if (error instanceof BaseWorkflowNotFoundError) {
      throw error;
    }
    throw new BaseWorkflowNotFoundError(extendsName, []);
  }

  // Recurse into the base workflow (may itself have extends)
  const baseDefinition = await loadWorkflowWithExtends(basePath, resolver, seen);

  // Extract override data from the extending workflow's YAML
  const overrideData: Parameters<typeof mergeWorkflows>[1] = {};
  if (data.name !== undefined) overrideData.name = data.name as string;
  if (data.description !== undefined) overrideData.description = data.description as string;
  if (data.version !== undefined) overrideData.version = data.version as string;
  if (data.timeout !== undefined) overrideData.timeout = data.timeout as number;
  if (data.retry !== undefined) overrideData.retry = data.retry as typeof overrideData.retry;
  if (data.phases !== undefined) overrideData.phases = data.phases as typeof overrideData.phases;
  if (data.overrides !== undefined) overrideData.overrides = data.overrides as typeof overrideData.overrides;

  // Merge base + overrides
  const merged = mergeWorkflows(baseDefinition, overrideData);

  // Validate the merged result against the strict schema
  return validateWorkflow(merged);
}

// Re-export validation utilities
export { validateWorkflow, isValidWorkflow, WorkflowValidationError } from './validator.js';
export {
  WorkflowDefinitionSchema,
  PhaseDefinitionSchema,
  StepDefinitionSchema,
  InputDefinitionSchema,
  RetryConfigSchema,
} from './schema.js';
