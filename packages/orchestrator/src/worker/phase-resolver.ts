import { PHASE_SEQUENCE, getPhaseSequence, type WorkflowPhase } from './types.js';

/**
 * Unified mapping from gate names to their owning phase and the phase to resume from.
 *
 * - `phase`: the workflow phase this gate belongs to (used to normalize gate names in resolveFromProcess)
 * - `resumeFrom`: the phase to start from when the gate is satisfied (used in resolveFromContinue)
 */
export const GATE_MAPPING: Record<string, { phase: WorkflowPhase; resumeFrom: WorkflowPhase }> = {
  'clarification':          { phase: 'clarify',    resumeFrom: 'clarify' },
  'spec-review':            { phase: 'specify',    resumeFrom: 'clarify' },
  'clarification-review':   { phase: 'clarify',    resumeFrom: 'clarify' },
  'plan-review':            { phase: 'plan',       resumeFrom: 'tasks' },
  'tasks-review':           { phase: 'tasks',      resumeFrom: 'implement' },
  'implementation-review':  { phase: 'implement',  resumeFrom: 'validate' },
  'manual-validation':      { phase: 'validate',   resumeFrom: 'validate' },
};

/**
 * Workflow-specific gate mappings that override the global GATE_MAPPING.
 *
 * For epic workflows, certain gates have different resume behavior:
 * - `tasks-review`: resumes to 'tasks' (triggers post-tasks/child creation, not implement)
 * - `children-complete`: dedicated handling (routes to epic-complete command)
 * - `epic-approval`: dedicated handling (routes to epic-close)
 */
export const WORKFLOW_GATE_MAPPING: Record<string, Record<string, { phase: WorkflowPhase; resumeFrom: WorkflowPhase }>> = {
  'speckit-epic': {
    'tasks-review':       { phase: 'tasks', resumeFrom: 'tasks' },
    'children-complete':  { phase: 'tasks', resumeFrom: 'tasks' },
    'epic-approval':      { phase: 'tasks', resumeFrom: 'tasks' },
  },
};

/**
 * Resolve the starting phase based on issue labels and command type.
 */
export class PhaseResolver {
  /**
   * Determine the starting phase for a queue item.
   *
   * - 'process' command: inspects completed/phase labels to find the next uncompleted phase.
   * - 'continue' command: matches completed gate labels via GATE_MAPPING to determine resume phase.
   *
   * @param workflowName - Optional workflow name for workflow-specific gate resolution.
   *   When provided, uses the workflow's phase sequence and gate mappings.
   */
  resolveStartPhase(
    labels: string[],
    command: 'process' | 'continue',
    workflowName?: string,
  ): WorkflowPhase {
    if (command === 'continue') {
      return this.resolveFromContinue(labels, workflowName);
    }
    return this.resolveFromProcess(labels, workflowName);
  }

  /**
   * For 'process' command: find the starting phase from labels.
   *
   * Priority:
   * 1. If a `phase:*` label exists, resume from that phase
   * 2. If `completed:*` labels exist, start from next uncompleted phase
   *    (gate names like 'clarification' are normalized to phase names via GATE_MAPPING)
   * 3. If no phase labels, start from 'specify'
   */
  private resolveFromProcess(labels: string[], workflowName?: string): WorkflowPhase {
    const sequence = workflowName ? getPhaseSequence(workflowName) : PHASE_SEQUENCE;
    const effectiveGateMapping = this.getEffectiveGateMapping(workflowName);

    // Check for an active phase label
    for (const label of labels) {
      if (label.startsWith('phase:')) {
        const phase = label.slice('phase:'.length) as WorkflowPhase;
        if (sequence.includes(phase)) {
          return phase;
        }
      }
    }

    // Find the last completed phase and return the next one.
    // Normalize gate names (e.g., 'clarification') to phase names (e.g., 'clarify')
    // so phase sequence iteration matches correctly.
    const completedPhases = new Set<string>();
    for (const label of labels) {
      if (label.startsWith('completed:')) {
        const name = label.slice('completed:'.length);
        completedPhases.add(name);
        const gateEntry = effectiveGateMapping[name];
        if (gateEntry) {
          completedPhases.add(gateEntry.phase);
        }
      }
    }

    if (completedPhases.size > 0) {
      for (const phase of sequence) {
        if (!completedPhases.has(phase)) {
          return phase;
        }
      }
      // All phases completed — return the last phase in the sequence as the terminal phase
      return sequence[sequence.length - 1]!;
    }

    // No phase labels at all — start from beginning
    return 'specify';
  }

  /**
   * For 'continue' command: find which gate was just satisfied and resume from the next phase.
   *
   * Does not depend on `waiting-for:*` labels (those are removed by the worker on resume).
   * Matches `completed:*` labels against the effective gate mapping (workflow-specific first,
   * then global GATE_MAPPING) and returns the most advanced gate's resumeFrom phase.
   */
  private resolveFromContinue(labels: string[], workflowName?: string): WorkflowPhase {
    const sequence = workflowName ? getPhaseSequence(workflowName) : PHASE_SEQUENCE;
    const effectiveGateMapping = this.getEffectiveGateMapping(workflowName);

    const completedGates = new Set<string>();

    for (const label of labels) {
      if (label.startsWith('completed:')) {
        const name = label.slice('completed:'.length);
        if (effectiveGateMapping[name]) {
          completedGates.add(name);
        }
      }
    }

    // Iterate phases latest-to-earliest — most advanced gate wins
    for (let i = sequence.length - 1; i >= 0; i--) {
      const phase = sequence[i];
      for (const gateName of completedGates) {
        const mapping = effectiveGateMapping[gateName];
        if (mapping && mapping.phase === phase) {
          return mapping.resumeFrom;
        }
      }
    }

    // Fallback: use the process resolver
    return this.resolveFromProcess(labels, workflowName);
  }

  /**
   * Build the effective gate mapping for a workflow.
   * Workflow-specific mappings in WORKFLOW_GATE_MAPPING override entries in the global GATE_MAPPING.
   */
  private getEffectiveGateMapping(
    workflowName?: string,
  ): Record<string, { phase: WorkflowPhase; resumeFrom: WorkflowPhase }> {
    if (!workflowName || !WORKFLOW_GATE_MAPPING[workflowName]) {
      return GATE_MAPPING;
    }

    return {
      ...GATE_MAPPING,
      ...WORKFLOW_GATE_MAPPING[workflowName],
    };
  }
}
