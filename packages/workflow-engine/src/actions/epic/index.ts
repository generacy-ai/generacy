/**
 * Epic namespace actions - manages epic workflows and child issues.
 */
import type { ActionNamespace, ActionHandler } from '../../types/action.js';
import { PostTasksSummaryAction } from './post-tasks-summary.js';
import { CheckCompletionAction } from './check-completion.js';
import { UpdateStatusAction } from './update-status.js';
import { CreateEpicPRAction } from './create-pr.js';
import { CloseEpicAction } from './close.js';
import { DispatchChildrenAction } from './dispatch-children.js';

/**
 * All epic action handlers
 */
export const epicActionHandlers: ActionHandler[] = [
  new PostTasksSummaryAction(),
  new CheckCompletionAction(),
  new UpdateStatusAction(),
  new CreateEpicPRAction(),
  new CloseEpicAction(),
  new DispatchChildrenAction(),
];

/**
 * Epic namespace definition
 */
export const epicNamespace: ActionNamespace = {
  namespace: 'epic',
  description: 'Epic management actions for parent/child issue workflows',
  handlers: epicActionHandlers,
};

// Export individual actions for direct use
export { PostTasksSummaryAction } from './post-tasks-summary.js';
export { CheckCompletionAction } from './check-completion.js';
export { UpdateStatusAction } from './update-status.js';
export { CreateEpicPRAction } from './create-pr.js';
export { CloseEpicAction } from './close.js';
export { DispatchChildrenAction } from './dispatch-children.js';

// Shared utilities
export { findChildIssues, type EpicChildWithPr, type FindChildIssuesOptions } from './find-children.js';
