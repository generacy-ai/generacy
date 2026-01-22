/**
 * Language module for Generacy workflow YAML files.
 * Provides schema loading, validation, and diagnostic formatting.
 */

// Schema loading and registration
export {
  getWorkflowSchemaUri,
  registerWorkflowSchema,
  unregisterWorkflowSchema,
  isYamlExtensionAvailable,
  getRecommendedExtensions,
  promptForRecommendedExtensions,
} from './schema';

// Validation
export {
  workflowSchema,
  validateWorkflow,
  validateWorkflowYaml,
  validateWorkflowFile,
  validateWorkflowFull,
  validateUniqueNames,
} from './validator';

// Types
export type {
  Workflow,
  Phase,
  Step,
  Trigger,
  ErrorHandler,
  RetryConfig,
  Condition,
  Position,
  Range,
  ValidationError,
  ValidationResult,
} from './validator';

export { ValidationSeverity } from './validator';

// Diagnostic formatting
export {
  toDiagnostic,
  toDiagnostics,
  WorkflowDiagnosticCollection,
  formatValidationSummary,
  formatValidationDetails,
  getQuickFixes,
  QuickFixAction,
} from './formatter';

export type { QuickFix } from './formatter';
