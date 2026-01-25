/**
 * Workflow YAML loader.
 * Loads and parses workflow definition files.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { validateWorkflow, WorkflowValidationError } from './validator.js';
import type { WorkflowDefinition } from '../types/workflow.js';
import type { ExecutableWorkflow } from '../types/execution.js';

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

// Re-export validation utilities
export { validateWorkflow, isValidWorkflow, WorkflowValidationError } from './validator.js';
export {
  WorkflowDefinitionSchema,
  PhaseDefinitionSchema,
  StepDefinitionSchema,
  InputDefinitionSchema,
  RetryConfigSchema,
} from './schema.js';
