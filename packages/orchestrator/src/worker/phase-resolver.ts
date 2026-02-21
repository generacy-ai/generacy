import { PHASE_SEQUENCE, type WorkflowPhase } from './types.js';

/**
 * Unified mapping from gate names to their owning phase and the phase to resume from.
 *
 * - `phase`: the workflow phase this gate belongs to (used to normalize gate names in resolveFromProcess)
 * - `resumeFrom`: the phase to start from when the gate is satisfied (used in resolveFromContinue)
 */
export const GATE_MAPPING: Record<string, { phase: WorkflowPhase; resumeFrom: WorkflowPhase }> = {
  'clarification':          { phase: 'clarify',    resumeFrom: 'plan' },
  'spec-review':            { phase: 'specify',    resumeFrom: 'clarify' },
  'clarification-review':   { phase: 'clarify',    resumeFrom: 'plan' },
  'plan-review':            { phase: 'plan',       resumeFrom: 'tasks' },
  'tasks-review':           { phase: 'tasks',      resumeFrom: 'implement' },
  'implementation-review':  { phase: 'implement',  resumeFrom: 'validate' },
  'manual-validation':      { phase: 'validate',   resumeFrom: 'validate' },
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
   */
  resolveStartPhase(
    labels: string[],
    command: 'process' | 'continue',
  ): WorkflowPhase {
    if (command === 'continue') {
      return this.resolveFromContinue(labels);
    }
    return this.resolveFromProcess(labels);
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
  private resolveFromProcess(labels: string[]): WorkflowPhase {
    // Check for an active phase label
    for (const label of labels) {
      if (label.startsWith('phase:')) {
        const phase = label.slice('phase:'.length) as WorkflowPhase;
        if (PHASE_SEQUENCE.includes(phase)) {
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
        const gateEntry = GATE_MAPPING[name];
        if (gateEntry) {
          completedPhases.add(gateEntry.phase);
        }
      }
    }

    if (completedPhases.size > 0) {
      for (const phase of PHASE_SEQUENCE) {
        if (!completedPhases.has(phase)) {
          return phase;
        }
      }
      // All phases completed — return validate as the terminal phase
      return 'validate';
    }

    // No phase labels at all — start from beginning
    return 'specify';
  }

  /**
   * For 'continue' command: find which gate was just satisfied and resume from the next phase.
   *
   * Does not depend on `waiting-for:*` labels (those are removed by the worker on resume).
   * Matches `completed:*` labels against GATE_MAPPING and returns the most advanced gate's
   * resumeFrom phase.
   */
  private resolveFromContinue(labels: string[]): WorkflowPhase {
    const completedGates = new Set<string>();

    for (const label of labels) {
      if (label.startsWith('completed:')) {
        const name = label.slice('completed:'.length);
        if (GATE_MAPPING[name]) {
          completedGates.add(name);
        }
      }
    }

    // Iterate phases latest-to-earliest — most advanced gate wins
    for (let i = PHASE_SEQUENCE.length - 1; i >= 0; i--) {
      const phase = PHASE_SEQUENCE[i];
      for (const gateName of completedGates) {
        const mapping = GATE_MAPPING[gateName];
        if (mapping && mapping.phase === phase) {
          return mapping.resumeFrom;
        }
      }
    }

    // Fallback: use the process resolver
    return this.resolveFromProcess(labels);
  }
}
