/**
 * Workflow Explorer module exports
 */

// Tree items
export {
  WorkflowTreeItem,
  PhaseTreeItem,
  StepTreeItem,
  isWorkflowTreeItem,
  isPhaseTreeItem,
  isStepTreeItem,
  type WorkflowExplorerItem,
  type ValidationStatus,
  type WorkflowItemData,
  type PhaseData,
  type StepData,
  type ParsedWorkflow,
} from './tree-item';

// Provider
export {
  WorkflowTreeProvider,
  createWorkflowTreeProvider,
} from './provider';

// Decorations
export {
  WorkflowDecorationProvider,
  getWorkflowDecorationProvider,
  registerWorkflowDecorationProvider,
  resetWorkflowDecorationProvider,
  type WorkflowDecorationData,
} from './decorations';

// Templates
export {
  TemplateManager,
  getTemplateManager,
  showTemplateQuickPick,
  createTemplateQuickPickItems,
  type TemplateMetadata,
  type WorkflowTemplate,
  type TemplateQuickPickItem,
} from './templates';
