/**
 * Workflow action namespace registration.
 * Exports all workflow.* actions and provides namespace registration.
 */
import type { ActionNamespace, ActionHandler } from '../../types/index.js';

// Workflow actions
import { UpdatePhaseAction } from './update-phase.js';
import { CheckGateAction } from './check-gate.js';
import { UpdateStageAction } from './update-stage.js';

// Re-export action classes
export { UpdatePhaseAction } from './update-phase.js';
export { CheckGateAction } from './check-gate.js';
export { UpdateStageAction } from './update-stage.js';

/**
 * All workflow action handlers
 */
export const workflowActionHandlers: ActionHandler[] = [
  new UpdatePhaseAction(),
  new CheckGateAction(),
  new UpdateStageAction(),
];

/**
 * Workflow action namespace definition
 */
export const workflowNamespace: ActionNamespace = {
  namespace: 'workflow',
  description: 'Workflow state management for phase progression and review gates',
  handlers: workflowActionHandlers,
};

/**
 * Get all workflow action handlers
 */
export function getWorkflowActionHandlers(): ActionHandler[] {
  return [...workflowActionHandlers];
}
