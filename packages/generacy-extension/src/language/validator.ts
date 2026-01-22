/**
 * Zod-based runtime validator for Generacy workflow YAML files.
 * Provides type-safe validation with detailed error messages.
 */
import { z } from 'zod';
import * as yaml from 'yaml';
import * as vscode from 'vscode';
import { ErrorCode, GeneracyError } from '../utils/errors';

// ============================================================================
// Duration Pattern
// ============================================================================

/**
 * Duration string pattern (e.g., "30m", "2h", "3600s")
 */
const durationPattern = /^\d+[smh]$/;
const durationSchema = z.string().regex(durationPattern, {
  message: 'Duration must be a number followed by s (seconds), m (minutes), or h (hours)',
});

// ============================================================================
// Reference Schemas
// ============================================================================

/**
 * Secret reference schema
 */
const secretRefSchema = z.object({
  secret: z.string().regex(/^[A-Z][A-Z0-9_]*$/, {
    message: 'Secret name must be uppercase with underscores (e.g., API_KEY)',
  }),
});

/**
 * Environment variable reference schema
 */
const envRefSchema = z.object({
  env: z.string().min(1, 'Environment variable name is required'),
  default: z.string().optional(),
});

/**
 * Environment value - can be string, secret ref, or env ref
 */
const envValueSchema = z.union([z.string(), secretRefSchema, envRefSchema]);

/**
 * Environment object schema
 */
const envSchema = z.record(z.string(), envValueSchema);

// ============================================================================
// Condition Schema
// ============================================================================

/**
 * Condition schema - string expression or object with `if` property
 */
const conditionSchema = z.union([
  z.string().min(1, 'Condition expression cannot be empty'),
  z.object({
    if: z.string().min(1, 'Condition if expression cannot be empty'),
  }).strict(),
]);

// ============================================================================
// Retry Configuration
// ============================================================================

/**
 * Retry configuration schema
 */
const retryConfigSchema = z.object({
  max_attempts: z.number().int().min(1).max(10).default(3),
  delay: durationSchema.default('10s'),
  backoff: z.enum(['constant', 'linear', 'exponential']).default('exponential'),
  max_delay: durationSchema.optional(),
}).strict();

// ============================================================================
// Step Schema
// ============================================================================

/**
 * Step schema - individual step within a phase
 */
const stepSchema = z.object({
  name: z.string()
    .min(1, 'Step name is required')
    .max(64, 'Step name must be at most 64 characters')
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, {
      message: 'Step name must start with a letter and contain only letters, numbers, underscores, and hyphens',
    }),
  description: z.string().max(512).optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  run: z.string().min(1, 'Run command cannot be empty').optional(),
  condition: conditionSchema.optional(),
  env: envSchema.optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  timeout: durationSchema.optional(),
  retry: retryConfigSchema.optional(),
  continue_on_error: z.boolean().default(false),
}).strict().refine(
  (data) => data.uses !== undefined || data.run !== undefined,
  {
    message: 'Step must have either "uses" or "run" defined',
    path: ['uses'],
  }
).refine(
  (data) => !(data.uses !== undefined && data.run !== undefined),
  {
    message: 'Step cannot have both "uses" and "run" defined',
    path: ['run'],
  }
);

// ============================================================================
// Error Handler Schema
// ============================================================================

/**
 * Notification configuration schema
 */
const notificationSchema = z.object({
  type: z.enum(['slack', 'email', 'webhook']),
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Error handler schema
 */
const errorHandlerSchema = z.object({
  strategy: z.enum(['fail', 'continue', 'retry']).default('fail'),
  notify: z.array(notificationSchema).optional(),
  cleanup: z.array(z.lazy(() => stepSchema)).optional(),
}).strict();

// ============================================================================
// Phase Schema
// ============================================================================

/**
 * Phase schema - group of steps
 */
const phaseSchema = z.object({
  name: z.string()
    .min(1, 'Phase name is required')
    .max(64, 'Phase name must be at most 64 characters')
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, {
      message: 'Phase name must start with a letter and contain only letters, numbers, underscores, and hyphens',
    }),
  description: z.string().max(512).optional(),
  condition: conditionSchema.optional(),
  env: envSchema.optional(),
  steps: z.array(stepSchema).min(1, 'Phase must have at least one step'),
  on_error: errorHandlerSchema.optional(),
  timeout: durationSchema.optional(),
  retry: retryConfigSchema.optional(),
}).strict();

// ============================================================================
// Trigger Schema
// ============================================================================

/**
 * Trigger filter schema
 */
const triggerFilterSchema = z.object({
  branches: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
}).passthrough(); // Allow additional filter properties

/**
 * Schedule trigger config schema
 */
const scheduleConfigSchema = z.object({
  cron: z.string().min(1, 'Cron expression is required for schedule triggers'),
  timezone: z.string().optional(),
});

/**
 * Trigger schema
 */
const triggerSchema = z.object({
  type: z.enum(['manual', 'schedule', 'webhook', 'issue', 'pull_request', 'push']),
  config: z.record(z.string(), z.unknown()).optional(),
  filters: triggerFilterSchema.optional(),
}).strict().superRefine((data, ctx) => {
  if (data.type === 'schedule') {
    const result = scheduleConfigSchema.safeParse(data.config);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ['config', ...issue.path],
        });
      }
    }
  }
});

// ============================================================================
// Workflow Schema
// ============================================================================

/**
 * Complete workflow schema
 */
export const workflowSchema = z.object({
  name: z.string()
    .min(1, 'Workflow name is required')
    .max(128, 'Workflow name must be at most 128 characters')
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, {
      message: 'Workflow name must start with a letter and contain only letters, numbers, underscores, and hyphens',
    }),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, {
    message: 'Version must follow semantic versioning (e.g., 1.0.0)',
  }),
  description: z.string().max(1024).optional(),
  triggers: z.array(triggerSchema).optional(),
  env: envSchema.optional(),
  phases: z.array(phaseSchema).min(1, 'Workflow must have at least one phase'),
  on_error: errorHandlerSchema.optional(),
  timeout: durationSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

// ============================================================================
// Types
// ============================================================================

/**
 * Inferred workflow type from the schema
 */
export type Workflow = z.infer<typeof workflowSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type ErrorHandler = z.infer<typeof errorHandlerSchema>;
export type RetryConfig = z.infer<typeof retryConfigSchema>;
export type Condition = z.infer<typeof conditionSchema>;

// ============================================================================
// Validation Result Types
// ============================================================================

/**
 * Position in a document (line and column are 1-based)
 */
export interface Position {
  line: number;
  column: number;
  offset: number;
}

/**
 * Range in a document
 */
export interface Range {
  start: Position;
  end: Position;
}

/**
 * Severity of a validation error
 */
export enum ValidationSeverity {
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
  Hint = 'hint',
}

/**
 * Single validation error with source location
 */
export interface ValidationError {
  message: string;
  path: (string | number)[];
  severity: ValidationSeverity;
  range?: Range;
  code?: string;
  suggestions?: string[];
}

/**
 * Validation result containing all errors
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  workflow?: Workflow;
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validates a workflow object against the schema
 */
export function validateWorkflow(workflow: unknown): ValidationResult {
  const result = workflowSchema.safeParse(workflow);

  if (result.success) {
    return {
      valid: true,
      errors: [],
      workflow: result.data,
    };
  }

  const errors: ValidationError[] = result.error.issues.map((issue) => ({
    message: issue.message,
    path: issue.path,
    severity: ValidationSeverity.Error,
    code: issue.code,
    suggestions: getSuggestionsForIssue(issue),
  }));

  return {
    valid: false,
    errors,
  };
}

/**
 * Parses and validates a YAML string as a workflow
 */
export function validateWorkflowYaml(yamlContent: string): ValidationResult {
  try {
    // Parse YAML with source map for error positions
    const doc = yaml.parseDocument(yamlContent, {
      keepSourceTokens: true,
    });

    // Check for YAML parse errors
    if (doc.errors.length > 0) {
      const errors: ValidationError[] = doc.errors.map((err) => ({
        message: err.message,
        path: [],
        severity: ValidationSeverity.Error,
        range: getYamlErrorRange(err),
        code: 'YAML_PARSE_ERROR',
      }));

      return {
        valid: false,
        errors,
      };
    }

    // Convert to JS object and validate
    const workflow = doc.toJS();
    const result = validateWorkflow(workflow);

    // Add source positions to validation errors
    if (!result.valid) {
      result.errors = result.errors.map((error) => ({
        ...error,
        range: findPathRange(doc, error.path),
      }));
    }

    return result;
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          message: error instanceof Error ? error.message : 'Unknown YAML parse error',
          path: [],
          severity: ValidationSeverity.Error,
          code: 'YAML_PARSE_ERROR',
        },
      ],
    };
  }
}

/**
 * Validates a workflow file by URI
 */
export async function validateWorkflowFile(uri: vscode.Uri): Promise<ValidationResult> {
  try {
    const content = await vscode.workspace.fs.readFile(uri);
    const yamlContent = Buffer.from(content).toString('utf-8');
    return validateWorkflowYaml(yamlContent);
  } catch (error) {
    const err = GeneracyError.from(error, ErrorCode.FileReadError, `Failed to read workflow file: ${uri.fsPath}`);
    return {
      valid: false,
      errors: [
        {
          message: err.message,
          path: [],
          severity: ValidationSeverity.Error,
          code: 'FILE_READ_ERROR',
        },
      ],
    };
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets suggestions for fixing a validation issue
 */
function getSuggestionsForIssue(issue: z.ZodIssue): string[] {
  const suggestions: string[] = [];

  switch (issue.code) {
    case 'invalid_type':
      suggestions.push(`Expected ${issue.expected}, received ${issue.received}`);
      break;
    case 'invalid_string':
      if ('validation' in issue && issue.validation === 'regex') {
        // Add pattern-specific suggestions
        const path = issue.path.join('.');
        if (path.endsWith('.name')) {
          suggestions.push('Names must start with a letter and contain only letters, numbers, underscores, and hyphens');
        } else if (path.endsWith('.version')) {
          suggestions.push('Use semantic versioning format: MAJOR.MINOR.PATCH (e.g., 1.0.0)');
        }
      }
      break;
    case 'too_small':
      if ('minimum' in issue) {
        suggestions.push(`Minimum length is ${issue.minimum}`);
      }
      break;
    case 'too_big':
      if ('maximum' in issue) {
        suggestions.push(`Maximum length is ${issue.maximum}`);
      }
      break;
    case 'unrecognized_keys':
      if ('keys' in issue) {
        suggestions.push(`Remove unrecognized properties: ${(issue.keys as string[]).join(', ')}`);
      }
      break;
  }

  return suggestions;
}

/**
 * Extracts range from a YAML parse error
 */
function getYamlErrorRange(error: yaml.YAMLError): Range | undefined {
  if (error.pos && error.linePos) {
    return {
      start: {
        line: error.linePos[0].line,
        column: error.linePos[0].col,
        offset: error.pos[0],
      },
      end: {
        line: error.linePos[1]?.line ?? error.linePos[0].line,
        column: error.linePos[1]?.col ?? error.linePos[0].col + 1,
        offset: error.pos[1] ?? error.pos[0] + 1,
      },
    };
  }
  return undefined;
}

/**
 * Finds the source range for a path in the YAML document
 */
function findPathRange(doc: yaml.Document, path: (string | number)[]): Range | undefined {
  if (path.length === 0) {
    return undefined;
  }

  try {
    // Navigate to the node at the path
    let current: yaml.YAMLMap | yaml.YAMLSeq | yaml.Scalar | undefined = doc.contents as yaml.YAMLMap;

    for (const segment of path) {
      if (!current) break;

      if (yaml.isMap(current)) {
        // For maps, find the key-value pair
        const pair = current.items.find((item) => {
          const key = item.key;
          return yaml.isScalar(key) && key.value === segment;
        });
        if (pair) {
          current = pair.value as yaml.YAMLMap | yaml.YAMLSeq | yaml.Scalar;
        } else {
          current = undefined;
        }
      } else if (yaml.isSeq(current)) {
        // For sequences, get the item at the index
        const index = typeof segment === 'number' ? segment : parseInt(segment.toString(), 10);
        current = current.items[index] as yaml.YAMLMap | yaml.YAMLSeq | yaml.Scalar | undefined;
      }
    }

    // Get the range from the node
    if (current?.range) {
      const [startOffset, endOffset] = current.range;
      const startPos = findPosition(doc.toString(), startOffset);
      const endPos = findPosition(doc.toString(), endOffset);
      return {
        start: startPos,
        end: endPos,
      };
    }
  } catch {
    // If we can't find the path, return undefined
  }

  return undefined;
}

/**
 * Converts an offset to a Position (line and column)
 */
function findPosition(content: string, offset: number): Position {
  let line = 1;
  let column = 1;
  let currentOffset = 0;

  for (const char of content) {
    if (currentOffset >= offset) break;

    if (char === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
    currentOffset++;
  }

  return { line, column, offset };
}

/**
 * Validates unique names within a workflow
 */
export function validateUniqueNames(workflow: Workflow): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check for duplicate phase names
  const phaseNames = new Set<string>();
  for (let i = 0; i < workflow.phases.length; i++) {
    const phase = workflow.phases[i];
    if (phaseNames.has(phase.name)) {
      errors.push({
        message: `Duplicate phase name: "${phase.name}"`,
        path: ['phases', i, 'name'],
        severity: ValidationSeverity.Error,
        code: 'DUPLICATE_PHASE_NAME',
      });
    }
    phaseNames.add(phase.name);

    // Check for duplicate step names within each phase
    const stepNames = new Set<string>();
    for (let j = 0; j < phase.steps.length; j++) {
      const step = phase.steps[j];
      if (stepNames.has(step.name)) {
        errors.push({
          message: `Duplicate step name "${step.name}" in phase "${phase.name}"`,
          path: ['phases', i, 'steps', j, 'name'],
          severity: ValidationSeverity.Error,
          code: 'DUPLICATE_STEP_NAME',
        });
      }
      stepNames.add(step.name);
    }
  }

  return errors;
}

/**
 * Performs full validation including schema validation and semantic checks
 */
export function validateWorkflowFull(yamlContent: string): ValidationResult {
  const result = validateWorkflowYaml(yamlContent);

  // If basic validation failed, return those errors
  if (!result.valid || !result.workflow) {
    return result;
  }

  // Perform additional semantic validations
  const additionalErrors = validateUniqueNames(result.workflow);

  if (additionalErrors.length > 0) {
    return {
      valid: false,
      errors: [...result.errors, ...additionalErrors],
      workflow: result.workflow,
    };
  }

  return result;
}
