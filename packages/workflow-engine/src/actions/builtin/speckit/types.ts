/**
 * Types for speckit workflow actions.
 * Defines input/output interfaces for all speckit operations.
 */

/**
 * Speckit operation identifiers.
 * Extracted from step.uses or step.action string (e.g., 'speckit.create_feature' → 'create_feature')
 */
export type SpecKitOperation =
  | 'create_feature'
  | 'get_paths'
  | 'check_prereqs'
  | 'copy_template'
  | 'specify'
  | 'clarify'
  | 'plan'
  | 'tasks'
  | 'implement'
  | 'tasks_to_issues';

/**
 * Available template names for copy_template operation
 */
export type TemplateName = 'spec' | 'plan' | 'tasks' | 'checklist' | 'agent-file';

// --- Input Types ---

/**
 * Input for speckit.create_feature operation
 */
export interface CreateFeatureInput {
  /** Feature description used to generate spec content */
  description: string;
  /** Optional 2-4 word short name for the branch */
  short_name?: string;
  /** Optional explicit feature/issue number */
  number?: number;
  /** Parent epic branch to branch from (for epic children) */
  parent_epic_branch?: string;
  /** Working directory */
  cwd?: string;
}

/**
 * Input for speckit.get_paths operation
 */
export interface GetPathsInput {
  /** Optional branch/feature name. Auto-detected if not provided. */
  branch?: string;
  /** Working directory */
  cwd?: string;
}

/**
 * Input for speckit.check_prereqs operation
 */
export interface CheckPrereqsInput {
  /** Branch/feature name. Auto-detected if not provided. */
  branch?: string;
  /** Whether spec.md is required (default: true) */
  require_spec?: boolean;
  /** Whether plan.md is required (default: false) */
  require_plan?: boolean;
  /** Whether tasks.md is required (default: false) */
  require_tasks?: boolean;
  /** Include tasks.md in available_docs if it exists */
  include_tasks?: boolean;
  /** Working directory */
  cwd?: string;
}

/**
 * Input for speckit.copy_template operation
 */
export interface CopyTemplateInput {
  /** List of template names to copy */
  templates: TemplateName[];
  /** Target feature directory. Auto-detected if not provided. */
  feature_dir?: string;
  /** Optional custom destination filename (single template only) */
  dest_filename?: string;
  /** Working directory */
  cwd?: string;
}

/**
 * Input for speckit.specify operation
 */
export interface SpecifyInput {
  /** Path to feature directory */
  feature_dir: string;
  /** GitHub issue URL to extract context from */
  issue_url?: string;
  /** Agent timeout in seconds (default: 300) */
  timeout?: number;
}

/**
 * Input for speckit.clarify operation
 */
export interface ClarifyInput {
  /** Path to feature directory */
  feature_dir: string;
  /** GitHub issue number to post questions to */
  issue_number?: number;
  /** Agent timeout in seconds (default: 300) */
  timeout?: number;
}

/**
 * Input for speckit.plan operation
 */
export interface PlanInput {
  /** Path to feature directory */
  feature_dir: string;
  /** Agent timeout in seconds (default: 600) */
  timeout?: number;
}

/**
 * Input for speckit.tasks operation
 */
export interface TasksInput {
  /** Path to feature directory */
  feature_dir: string;
  /** Agent timeout in seconds (default: 300) */
  timeout?: number;
}

/**
 * Input for speckit.implement operation
 */
export interface ImplementInput {
  /** Path to feature directory */
  feature_dir: string;
  /** Pattern to filter specific tasks */
  task_filter?: string;
  /** Agent timeout in seconds per task (default: 600) */
  timeout?: number;
  /** Maximum tasks to complete before returning partial result for a fresh session (default: 10) */
  max_tasks_per_increment?: number;
}

// --- Output Types ---

/**
 * Output from speckit.create_feature operation
 */
export interface CreateFeatureOutput {
  success: boolean;
  branch_name: string;
  feature_num: string;
  spec_file: string;
  feature_dir: string;
  git_branch_created: boolean;
  branched_from_epic?: boolean;
  parent_epic_branch?: string;
  /** SHA of the commit the feature branch was based on */
  base_commit?: string;
  /** Descriptive error message when success is false */
  error?: string;
}

/**
 * Path configuration for a feature directory
 */
export interface FeaturePaths {
  repoRoot: string;
  branch: string;
  hasGit: boolean;
  featureDir: string;
  specFile: string;
  planFile: string;
  tasksFile: string;
  researchFile: string;
  dataModelFile: string;
  quickstartFile: string;
  contractsDir: string;
  checklistsDir: string;
  clarificationsFile: string;
}

/**
 * Output from speckit.get_paths operation
 */
export interface GetPathsOutput extends FeaturePaths {
  success: boolean;
  exists: boolean;
}

/**
 * Output from speckit.check_prereqs operation
 */
export interface CheckPrereqsOutput {
  valid: boolean;
  featureDir: string;
  availableDocs: string[];
  missingRequired?: string[];
  error?: string;
}

/**
 * Output from speckit.copy_template operation
 */
export interface CopyTemplateOutput {
  success: boolean;
  copied: Array<{ template: string; destPath: string }>;
  errors?: Array<{ template: string; error: { code: string; message: string } }>;
}

/**
 * Output from speckit.specify operation
 */
export interface SpecifyOutput {
  success: boolean;
  spec_file: string;
  summary: string;
  user_stories_count: number;
  functional_requirements_count: number;
}

/**
 * A clarification question
 */
export interface ClarificationQuestion {
  topic: string;
  context: string;
  question: string;
  options?: Array<{
    label: string;
    description: string;
  }>;
}

/**
 * Output from speckit.clarify operation
 */
export interface ClarifyOutput {
  success: boolean;
  questions_count: number;
  questions: ClarificationQuestion[];
  posted_to_issue?: boolean;
  clarifications_file: string;
}

/**
 * Output from speckit.plan operation
 */
export interface PlanOutput {
  success: boolean;
  plan_file: string;
  artifacts_created: string[];
  technologies: string[];
  phases_count: number;
}

/**
 * Output from speckit.tasks operation
 */
export interface TasksOutput {
  success: boolean;
  tasks_file: string;
  task_count: number;
  phases: string[];
  estimated_complexity: 'simple' | 'moderate' | 'complex';
}

/**
 * Output from speckit.implement operation
 */
export interface ImplementOutput {
  success: boolean;
  tasks_completed: number;
  tasks_total: number;
  tasks_skipped: number;
  files_modified: string[];
  tests_passed?: boolean;
  errors?: string[];
  /** True when the increment limit was reached and more tasks remain */
  partial?: boolean;
  /** Number of tasks still pending after this increment */
  tasks_remaining?: number;
}

// --- Error Types ---

/**
 * Error codes for speckit operations
 */
export type SpecKitErrorCode =
  | 'BRANCH_EXISTS'
  | 'BRANCH_EXISTS_FOR_ISSUE'
  | 'BRANCH_NOT_FOUND'
  | 'SPEC_NOT_FOUND'
  | 'PLAN_NOT_FOUND'
  | 'TASKS_NOT_FOUND'
  | 'FEATURE_DIR_NOT_FOUND'
  | 'TEMPLATE_NOT_FOUND'
  | 'GIT_NOT_INITIALIZED'
  | 'GIT_OPERATION_FAILED'
  | 'INVALID_BRANCH_NAME'
  | 'INVALID_FEATURE_NUMBER'
  | 'INVALID_OPERATION'
  | 'FILE_WRITE_FAILED'
  | 'FILE_READ_FAILED';

/**
 * Structured error for speckit operations
 */
export interface SpecKitError {
  code: SpecKitErrorCode;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Create a structured speckit error
 */
export function createSpecKitError(
  code: SpecKitErrorCode,
  message: string,
  context?: Record<string, unknown>
): SpecKitError {
  return { code, message, context };
}
