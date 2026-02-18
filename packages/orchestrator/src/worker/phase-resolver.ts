import { PHASE_SEQUENCE, type WorkflowPhase } from './types.js';

/**
 * Resolve the starting phase based on issue labels and command type.
 */
export class PhaseResolver {
  /**
   * Determine the starting phase for a queue item.
   *
   * - 'process' command: inspects completed/phase labels to find the next uncompleted phase.
   * - 'continue' command: finds the waiting-for label that was just satisfied and maps to the next phase.
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

    // Find the last completed phase and return the next one
    const completedPhases = new Set<string>();
    for (const label of labels) {
      if (label.startsWith('completed:')) {
        completedPhases.add(label.slice('completed:'.length));
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
   * For 'continue' command: find which waiting-for was just satisfied.
   *
   * Look for `completed:*` labels that match a `waiting-for:*` pattern
   * and determine the next phase to resume from.
   */
  private resolveFromContinue(labels: string[]): WorkflowPhase {
    const completedSet = new Set<string>();
    const waitingForSet = new Set<string>();

    for (const label of labels) {
      if (label.startsWith('completed:')) {
        completedSet.add(label.slice('completed:'.length));
      } else if (label.startsWith('waiting-for:')) {
        waitingForSet.add(label.slice('waiting-for:'.length));
      }
    }

    // If clarification was completed, resume from clarify (which will advance to plan)
    if (completedSet.has('clarification') && waitingForSet.has('clarification')) {
      return 'clarify';
    }

    // For review gates: find completed reviews and map to next phase
    const reviewToPhase: Record<string, WorkflowPhase> = {
      'spec-review': 'clarify',
      'clarification-review': 'plan',
      'plan-review': 'tasks',
      'tasks-review': 'implement',
      'implementation-review': 'validate',
      'manual-validation': 'validate',
    };

    for (const [review, nextPhase] of Object.entries(reviewToPhase)) {
      if (completedSet.has(review) && waitingForSet.has(review)) {
        return nextPhase;
      }
    }

    // Fallback: use the process resolver
    return this.resolveFromProcess(labels);
  }
}
