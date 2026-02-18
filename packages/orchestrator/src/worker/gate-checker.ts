import type { WorkflowPhase, GateDefinition, Logger } from './types.js';
import type { WorkerConfig } from './config.js';

/**
 * Checks configuration-driven review gates after each phase completes.
 *
 * Gates allow workflows to pause at specific phases for human review,
 * clarification, or failure handling before proceeding to the next phase.
 */
export class GateChecker {
  constructor(private readonly logger: Logger) {}

  /**
   * Check if a gate should be activated after the given phase completes.
   * Returns the GateDefinition if a gate is active, or null if no gate.
   *
   * @param phase - The phase that just completed
   * @param workflowName - The workflow type (e.g., 'speckit-feature', 'speckit-bugfix')
   * @param config - Worker configuration containing gate definitions
   */
  checkGate(
    phase: WorkflowPhase,
    workflowName: string,
    config: WorkerConfig,
  ): GateDefinition | null {
    const workflowGates = config.gates[workflowName];

    if (!workflowGates || workflowGates.length === 0) {
      this.logger.debug(
        { phase, workflowName },
        'No gates configured for workflow',
      );
      return null;
    }

    const gate = workflowGates.find((g) => g.phase === phase);

    if (!gate) {
      this.logger.debug(
        { phase, workflowName },
        'No gate defined for phase',
      );
      return null;
    }

    if (gate.condition === 'always') {
      this.logger.info(
        { phase, workflowName, gateLabel: gate.gateLabel, condition: gate.condition },
        'Gate activated: condition is always',
      );
      return gate;
    }

    // For 'on-questions' and 'on-failure', return the gate definition
    // and let the caller evaluate whether the condition is actually met.
    this.logger.info(
      { phase, workflowName, gateLabel: gate.gateLabel, condition: gate.condition },
      'Gate found: caller will evaluate condition',
    );
    return gate;
  }
}
