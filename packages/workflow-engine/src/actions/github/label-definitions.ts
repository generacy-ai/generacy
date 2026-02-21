/**
 * Shared label definitions for workflow management.
 *
 * These labels are used by sync-labels action and can be imported
 * by other modules that need to reference the canonical label set.
 */

/**
 * Label definition with required fields for workflow labels.
 */
export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

/**
 * Canonical set of workflow labels managed by the label sync utility.
 */
export const WORKFLOW_LABELS: LabelDefinition[] = [
  // Phase labels
  { name: 'phase:specify', color: '0052CC', description: 'Specification phase' },
  { name: 'phase:clarify', color: '0052CC', description: 'Clarification phase' },
  { name: 'phase:plan', color: '0052CC', description: 'Planning phase' },
  { name: 'phase:tasks', color: '0052CC', description: 'Task generation phase' },
  { name: 'phase:implement', color: '0052CC', description: 'Implementation phase' },
  { name: 'phase:validate', color: '0052CC', description: 'Validation phase' },

  // Waiting-for labels (review gates)
  { name: 'waiting-for:spec-review', color: 'FBCA04', description: 'Waiting for spec review' },
  { name: 'waiting-for:clarification', color: 'FBCA04', description: 'Waiting for clarification answers' },
  { name: 'waiting-for:clarification-review', color: 'FBCA04', description: 'Waiting for clarification review' },
  { name: 'waiting-for:plan-review', color: 'FBCA04', description: 'Waiting for plan review' },
  { name: 'waiting-for:tasks-review', color: 'FBCA04', description: 'Waiting for tasks review' },
  { name: 'waiting-for:implementation-review', color: 'FBCA04', description: 'Waiting for implementation review' },
  { name: 'waiting-for:manual-validation', color: 'FBCA04', description: 'Waiting for manual validation' },
  { name: 'waiting-for:pr-feedback', color: 'FBCA04', description: 'Waiting to address PR feedback' },
  { name: 'waiting-for:address-pr-feedback', color: 'FBCA04', description: 'Agent is addressing PR review feedback' },
  { name: 'waiting-for:children-complete', color: 'FBCA04', description: 'Waiting for child issues to complete' },
  { name: 'waiting-for:dependencies', color: 'FBCA04', description: 'Waiting for blocking issues' },

  // Completed labels
  { name: 'completed:spec-review', color: '0E8A16', description: 'Spec review completed' },
  { name: 'completed:clarification', color: '0E8A16', description: 'Clarification completed' },
  { name: 'completed:clarification-review', color: '0E8A16', description: 'Clarification review completed' },
  { name: 'completed:plan-review', color: '0E8A16', description: 'Plan review completed' },
  { name: 'completed:tasks-review', color: '0E8A16', description: 'Tasks review completed' },
  { name: 'completed:implementation-review', color: '0E8A16', description: 'Implementation review completed' },
  { name: 'completed:manual-validation', color: '0E8A16', description: 'Manual validation completed' },
  { name: 'completed:setup', color: '0E8A16', description: 'Setup phase completed' },
  { name: 'completed:specify', color: '0E8A16', description: 'Specification phase completed' },
  { name: 'completed:clarify', color: '0E8A16', description: 'Clarification phase completed' },
  { name: 'completed:plan', color: '0E8A16', description: 'Planning phase completed' },
  { name: 'completed:tasks', color: '0E8A16', description: 'Task generation completed' },
  { name: 'completed:implement', color: '0E8A16', description: 'Implementation completed' },
  { name: 'completed:validate', color: '0E8A16', description: 'Validation completed' },

  // Issue type labels
  { name: 'type:feature', color: '1D76DB', description: 'Feature request' },
  { name: 'type:bug', color: 'D73A4A', description: 'Bug report' },
  { name: 'type:epic', color: '5319E7', description: 'Epic issue with children' },

  // Agent labels
  { name: 'agent:dispatched', color: 'C5DEF5', description: 'Dispatched to agent queue' },
  { name: 'agent:in-progress', color: '0366D6', description: 'Agent is actively working' },
  { name: 'agent:paused', color: 'F9D0C4', description: 'Agent work is paused' },
  { name: 'agent:error', color: 'D73A4A', description: 'Agent encountered an error' },

  // Needs labels
  { name: 'needs:epic-approval', color: 'D93F0B', description: 'Epic PR needs approval' },
  { name: 'needs:human-review', color: 'D93F0B', description: 'Requires human review' },

  // Process trigger labels
  { name: 'process:speckit-feature', color: 'D876E3', description: 'Speckit feature process trigger' },
  { name: 'process:speckit-bugfix', color: 'D876E3', description: 'Speckit bugfix process trigger' },

  // Workflow identity labels (persist for issue lifetime)
  { name: 'workflow:speckit-feature', color: '6F42C1', description: 'Speckit feature workflow' },
  { name: 'workflow:speckit-bugfix', color: '6F42C1', description: 'Speckit bugfix workflow' },

  // Relationship labels
  { name: 'epic-child', color: 'bfd4f2', description: 'Child issue of an epic' },
];
