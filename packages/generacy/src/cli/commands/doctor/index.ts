// Barrel re-exports for the doctor module.

// Types
export type {
  CheckCategory,
  CheckContext,
  CheckDefinition,
  CheckResult,
  DoctorOptions,
  DoctorReport,
  DoctorReportCheckEntry,
  DoctorReportSummary,
  FixResult,
} from './types.js';

// Registry
export { CheckRegistry } from './registry.js';

// Runner
export { runChecks } from './runner.js';

// Formatter
export { formatJson, formatText } from './formatter.js';
