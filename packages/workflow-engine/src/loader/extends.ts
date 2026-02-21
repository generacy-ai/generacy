/**
 * Workflow merge logic for the `extends` inheritance mechanism.
 *
 * Merge semantics:
 * - Top-level scalars (name, description, version, timeout, retry): override wins if present
 * - Phases: matched by name from overrides.phases
 *   - Existing phase matched by name: steps replaced entirely, condition overridden if provided
 *   - New phase with before:/after: directive: inserted at specified position
 *   - New phase without positional directive: throws WorkflowOverrideError (fail fast on typos)
 * - Inputs: merged (base + override, override wins on name collision)
 * - Env: shallow merge, override wins on key collision
 * - `phases` and `overrides.phases` are mutually exclusive — throws WorkflowOverrideError if both present
 */
import { WorkflowOverrideError } from '../errors/workflow-override.js';
import type {
  WorkflowDefinition,
  PhaseDefinition,
  StepDefinition,
  InputDefinition,
  RetryConfig,
} from '../types/workflow.js';

/**
 * Override definition for a single phase.
 * Used within the `overrides.phases` block of an extending workflow.
 */
export interface PhaseOverride {
  /** Replacement steps for an existing phase */
  steps?: StepDefinition[];
  /** Override condition for an existing phase */
  condition?: string;
  /** Insert this new phase before the named phase */
  before?: string;
  /** Insert this new phase after the named phase */
  after?: string;
}

/**
 * The `overrides:` block from an extending workflow YAML.
 */
export interface WorkflowOverride {
  phases?: Record<string, PhaseOverride>;
  inputs?: InputDefinition[];
  env?: Record<string, string>;
}

/**
 * The override data extracted from an extending workflow's YAML.
 * Contains both top-level scalar overrides and the structured `overrides` block.
 */
export interface WorkflowOverrideData {
  name?: string;
  description?: string;
  version?: string;
  timeout?: number;
  retry?: RetryConfig;
  overrides?: WorkflowOverride;
  /** Full replacement mode: replace all phases instead of merging */
  phases?: PhaseDefinition[];
}

/**
 * Merge a base WorkflowDefinition with override data from an extending workflow.
 *
 * @param base - The fully resolved base workflow definition
 * @param overrideData - Override data from the extending workflow
 * @returns A new WorkflowDefinition with overrides applied
 * @throws WorkflowOverrideError if phases and overrides.phases are both present,
 *         or if a phase override references an unknown phase without a positional directive
 */
export function mergeWorkflows(
  base: WorkflowDefinition,
  overrideData: WorkflowOverrideData,
): WorkflowDefinition {
  // Mutual exclusivity: phases and overrides.phases cannot coexist
  if (overrideData.phases && overrideData.overrides?.phases) {
    throw new WorkflowOverrideError(
      'Cannot specify both "phases" and "overrides.phases" — use "phases" for full replacement or "overrides.phases" for selective override, not both.',
    );
  }

  // Start with a copy of the base
  const merged: WorkflowDefinition = {
    ...base,
    phases: [...base.phases.map(p => ({ ...p, steps: [...p.steps] }))],
  };

  // Top-level scalar overrides: override wins if present
  if (overrideData.name !== undefined) merged.name = overrideData.name;
  if (overrideData.description !== undefined) merged.description = overrideData.description;
  if (overrideData.version !== undefined) merged.version = overrideData.version;
  if (overrideData.timeout !== undefined) merged.timeout = overrideData.timeout;
  if (overrideData.retry !== undefined) merged.retry = overrideData.retry;

  // Full replacement mode: overrideData.phases replaces all base phases
  if (overrideData.phases) {
    merged.phases = overrideData.phases;
  }

  // Selective phase overrides via overrides.phases
  if (overrideData.overrides?.phases) {
    merged.phases = mergePhases(merged.phases, overrideData.overrides.phases);
  }

  // Input merging: base + override, override wins on name collision
  if (overrideData.overrides?.inputs) {
    merged.inputs = mergeInputs(base.inputs, overrideData.overrides.inputs);
  }

  // Env merging: shallow merge, override wins on key collision
  if (overrideData.overrides?.env) {
    merged.env = {
      ...base.env,
      ...overrideData.overrides.env,
    };
  }

  return merged;
}

/**
 * Merge base phases with phase overrides.
 *
 * - Existing phase matched by name: steps replaced entirely, condition overridden if provided
 * - New phase with before:/after: directive: inserted at specified position
 * - New phase without positional directive: throws WorkflowOverrideError
 */
function mergePhases(
  basePhases: PhaseDefinition[],
  phaseOverrides: Record<string, PhaseOverride>,
): PhaseDefinition[] {
  const result = basePhases.map(p => ({ ...p, steps: [...p.steps] }));
  const basePhaseNames = new Set(basePhases.map(p => p.name));

  // Track insertions to apply after processing all overrides
  const insertions: Array<{
    phase: PhaseDefinition;
    position: 'before' | 'after';
    anchor: string;
  }> = [];

  for (const [phaseName, override] of Object.entries(phaseOverrides)) {
    if (basePhaseNames.has(phaseName)) {
      // Override existing phase
      const idx = result.findIndex(p => p.name === phaseName);
      if (override.steps) {
        result[idx]!.steps = override.steps;
      }
      if (override.condition !== undefined) {
        result[idx]!.condition = override.condition;
      }
    } else if (override.before || override.after) {
      // New phase with positional directive
      if (!override.steps || override.steps.length === 0) {
        throw new WorkflowOverrideError(
          `New phase "${phaseName}" requires at least one step.`,
        );
      }

      const anchor = (override.before ?? override.after)!;
      if (!basePhaseNames.has(anchor)) {
        throw new WorkflowOverrideError(
          `Phase "${phaseName}" references anchor phase "${anchor}" which does not exist in the base workflow.`,
        );
      }

      insertions.push({
        phase: {
          name: phaseName,
          steps: override.steps,
          condition: override.condition,
        },
        position: override.before ? 'before' : 'after',
        anchor,
      });
    } else {
      // Unknown phase without positional directive — fail fast on typos
      throw new WorkflowOverrideError(
        `Phase "${phaseName}" does not exist in the base workflow and has no "before" or "after" directive. ` +
        `Did you mean one of: ${[...basePhaseNames].join(', ')}?`,
      );
    }
  }

  // Apply insertions (process in reverse order of anchor index to maintain correct positions)
  for (const insertion of insertions) {
    const anchorIdx = result.findIndex(p => p.name === insertion.anchor);
    const insertIdx = insertion.position === 'before' ? anchorIdx : anchorIdx + 1;
    result.splice(insertIdx, 0, insertion.phase);
  }

  return result;
}

/**
 * Merge base inputs with override inputs.
 * Override wins on name collision.
 */
function mergeInputs(
  baseInputs: InputDefinition[] | undefined,
  overrideInputs: InputDefinition[],
): InputDefinition[] {
  const inputMap = new Map<string, InputDefinition>();

  // Add base inputs first
  if (baseInputs) {
    for (const input of baseInputs) {
      inputMap.set(input.name, input);
    }
  }

  // Override inputs win on name collision
  for (const input of overrideInputs) {
    inputMap.set(input.name, input);
  }

  return [...inputMap.values()];
}
