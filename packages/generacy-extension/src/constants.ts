/**
 * Extension-wide constants for Generacy VS Code extension
 */

/**
 * Extension identifier matching publisher.name in package.json
 */
export const EXTENSION_ID = 'generacy-ai.generacy-extension';

/**
 * Extension display name
 */
export const EXTENSION_NAME = 'Generacy';

/**
 * Default workflow file extension patterns
 */
export const WORKFLOW_FILE_PATTERNS = {
  yaml: '**/.generacy/**/*.yaml',
  yml: '**/.generacy/**/*.yml',
} as const;

/**
 * Command identifiers - must match commands defined in package.json
 */
export const COMMANDS = {
  createWorkflow: 'generacy.createWorkflow',
  renameWorkflow: 'generacy.renameWorkflow',
  deleteWorkflow: 'generacy.deleteWorkflow',
  duplicateWorkflow: 'generacy.duplicateWorkflow',
  runWorkflow: 'generacy.runWorkflow',
  debugWorkflow: 'generacy.debugWorkflow',
  validateWorkflow: 'generacy.validateWorkflow',
  refreshExplorer: 'generacy.refreshExplorer',
  openWorkflow: 'generacy.openWorkflow',
  revealInExplorer: 'generacy.revealInExplorer',
} as const;

/**
 * View identifiers - must match views defined in package.json
 */
export const VIEWS = {
  workflows: 'generacy.workflows',
  queue: 'generacy.queue',
} as const;

/**
 * Context keys for when clauses
 */
export const CONTEXT_KEYS = {
  isAuthenticated: 'generacy.isAuthenticated',
  hasWorkspace: 'generacy.hasWorkspace',
  isDebugging: 'generacy.isDebugging',
} as const;

/**
 * Configuration keys - suffixes after 'generacy.'
 */
export const CONFIG_KEYS = {
  workflowDirectory: 'workflowDirectory',
  defaultTemplate: 'defaultTemplate',
  cloudEndpoint: 'cloudEndpoint',
  telemetryEnabled: 'telemetry.enabled',
} as const;

/**
 * Default configuration values
 */
export const DEFAULTS = {
  workflowDirectory: '.generacy',
  defaultTemplate: 'basic',
  cloudEndpoint: 'https://api.generacy.ai',
  telemetryEnabled: false,
} as const;

/**
 * Output channel name
 */
export const OUTPUT_CHANNEL_NAME = 'Generacy';

/**
 * Debug adapter type identifier
 */
export const DEBUG_TYPE = 'generacy';

/**
 * Language identifiers
 */
export const LANGUAGE_IDS = {
  workflow: 'generacy-workflow',
  yaml: 'yaml',
} as const;

/**
 * File extensions recognized as workflow files
 */
export const WORKFLOW_EXTENSIONS = ['.yaml', '.yml'] as const;

/**
 * Workflow templates available for creation
 */
export const WORKFLOW_TEMPLATES = {
  basic: 'basic',
  multiPhase: 'multi-phase',
  withTriggers: 'with-triggers',
} as const;

/**
 * Tree item context values for menus
 */
export const TREE_ITEM_CONTEXT = {
  workflow: 'workflow',
  phase: 'phase',
  step: 'step',
  queueItem: 'queueItem',
} as const;

/**
 * Status icons for workflow states
 */
export const STATUS_ICONS = {
  pending: '$(clock)',
  running: '$(sync~spin)',
  completed: '$(check)',
  failed: '$(error)',
  unknown: '$(question)',
} as const;
