/**
 * Workflow validation utility for publishing workflows to the cloud.
 * Validates workflow content size, YAML syntax, and basic structure.
 */
import * as vscode from 'vscode';
import { parse as parseYAML } from 'yaml';
import { MAX_WORKFLOW_SIZE } from '../../../api/types/workflows';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Result of workflow validation operation.
 * Contains validation status and detailed error information if validation fails.
 */
export interface ValidationResult {
  /** Whether the workflow is valid */
  valid: boolean;
  /** Specific error message if validation fails */
  error?: string;
  /** Line number where error occurred, if applicable */
  line?: number;
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validates workflow content for publishing to the cloud.
 * Performs three levels of validation:
 * 1. Size validation - ensures content doesn't exceed MAX_WORKFLOW_SIZE (5 MB)
 * 2. YAML syntax validation - ensures content is valid YAML
 * 3. Structure validation - ensures workflow has required 'name' field
 *
 * @param content - The workflow YAML content as a string
 * @returns ValidationResult with validation status and error details if invalid
 *
 * @example
 * ```typescript
 * const result = validateWorkflowContent(yamlContent);
 * if (!result.valid) {
 *   vscode.window.showErrorMessage(result.error!);
 * }
 * ```
 */
export function validateWorkflowContent(content: string): ValidationResult {
  // 1. Validate size
  const contentSizeBytes = Buffer.byteLength(content, 'utf8');
  if (contentSizeBytes > MAX_WORKFLOW_SIZE) {
    return {
      valid: false,
      error: 'Workflow file exceeds maximum size of 5 MB',
    };
  }

  // 2. Parse and validate YAML syntax
  let parsedWorkflow: any;
  try {
    parsedWorkflow = parseYAML(content);
  } catch (error: any) {
    // Extract line number from error if available
    const lineMatch = error.message?.match(/at line (\d+)/);
    const line = lineMatch ? parseInt(lineMatch[1], 10) : undefined;

    return {
      valid: false,
      error: `Invalid YAML${line ? ` at line ${line}` : ''}: ${error.message || 'Parse error'}`,
      line,
    };
  }

  // 3. Validate basic workflow structure
  if (!parsedWorkflow || typeof parsedWorkflow !== 'object') {
    return {
      valid: false,
      error: 'Workflow must be a valid YAML object',
    };
  }

  if (!parsedWorkflow.name || typeof parsedWorkflow.name !== 'string') {
    return {
      valid: false,
      error: "Workflow must have a 'name' field",
    };
  }

  // All validations passed
  return {
    valid: true,
  };
}

/**
 * Validates a workflow file for publishing to the cloud.
 * Reads the file content and delegates to validateWorkflowContent().
 *
 * @param fileUri - VS Code URI pointing to the workflow file
 * @returns Promise resolving to ValidationResult with validation status and error details
 *
 * @example
 * ```typescript
 * const fileUri = vscode.Uri.file('/path/to/workflow.yaml');
 * const result = await validateWorkflowFile(fileUri);
 * if (result.valid) {
 *   // Proceed with publishing
 * }
 * ```
 */
export async function validateWorkflowFile(fileUri: vscode.Uri): Promise<ValidationResult> {
  try {
    // Read file content as Uint8Array
    const contentBytes = await vscode.workspace.fs.readFile(fileUri);

    // Decode Uint8Array to string
    const content = Buffer.from(contentBytes).toString('utf8');

    // Validate the decoded content
    return validateWorkflowContent(content);
  } catch (error: any) {
    // Handle file system errors (file not found, permission denied, etc.)
    return {
      valid: false,
      error: `Failed to read workflow file: ${error.message || 'Unknown error'}`,
    };
  }
}
