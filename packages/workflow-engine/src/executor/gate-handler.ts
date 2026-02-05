/**
 * Gate handler integration for workflow executor.
 * Manages gate registration and execution during workflow steps.
 */
import type {
  GateType,
  GateConfig,
  GateContext,
  GateResult,
  GateHandler,
  ExecutableWorkflow,
  PhaseDefinition,
  StepDefinition,
  ActionResult,
} from '../types/index.js';
import { DefaultGateHandler, parseGateConfig } from '../types/gate.js';

/**
 * Registry of gate handlers by type
 */
const gateHandlerRegistry = new Map<GateType, GateHandler>();

/** Default handler for gates without a specific handler */
const defaultHandler = new DefaultGateHandler();

/**
 * Register a custom gate handler for a specific gate type
 */
export function registerGateHandler(gateType: GateType, handler: GateHandler): void {
  gateHandlerRegistry.set(gateType, handler);
}

/**
 * Unregister a gate handler
 */
export function unregisterGateHandler(gateType: GateType): void {
  gateHandlerRegistry.delete(gateType);
}

/**
 * Get the handler for a gate type
 */
export function getGateHandler(gateType: GateType): GateHandler {
  return gateHandlerRegistry.get(gateType) ?? defaultHandler;
}

/**
 * Check if a gate is configured for a step
 */
export function hasGate(step: StepDefinition): boolean {
  return typeof step.gate === 'string' && step.gate.length > 0;
}

/**
 * Get gate configuration from a step
 */
export function getGateConfig(step: StepDefinition): GateConfig | null {
  if (!hasGate(step)) {
    return null;
  }
  return parseGateConfig(step.gate!);
}

/**
 * Result from processing a gate
 */
export interface GateProcessResult {
  /** Whether the gate was approved and workflow should continue */
  continue: boolean;

  /** Whether workflow should pause (gate pending) */
  pause: boolean;

  /** The gate result with details */
  result: GateResult;

  /** The gate configuration */
  config: GateConfig;
}

/**
 * Process a gate after step execution.
 * This is called by the executor after a step with a gate completes successfully.
 *
 * @param workflow The executing workflow
 * @param phase Current phase
 * @param step The step with the gate
 * @param stepResult Result from step execution
 * @param executionId Optional workflow execution ID
 * @returns Gate processing result
 */
export async function processGate(
  workflow: ExecutableWorkflow,
  phase: PhaseDefinition,
  step: StepDefinition,
  stepResult: ActionResult,
  executionId?: string
): Promise<GateProcessResult> {
  const config = getGateConfig(step);
  if (!config) {
    // No gate, continue immediately
    return {
      continue: true,
      pause: false,
      result: { approved: true, approvedBy: 'system' },
      config: { type: 'none' },
    };
  }

  const context: GateContext = {
    workflow,
    phase,
    step,
    stepResult,
    gateType: config.type,
    executionId,
  };

  const handler = config.handler ?? getGateHandler(config.type);

  // First check if already approved (non-blocking)
  const isPreApproved = await handler.checkApproval(context);
  if (isPreApproved) {
    return {
      continue: true,
      pause: false,
      result: { approved: true, approvedBy: 'pre-approval' },
      config,
    };
  }

  // Request approval notification if handler supports it
  if (handler.requestApproval) {
    await handler.requestApproval(context);
  }

  // Wait for approval
  const result = await handler.waitForApproval(context, config.timeout_ms);

  // Handle timeout action
  if (result.timedOut && config.timeout_action) {
    switch (config.timeout_action) {
      case 'approve':
        return {
          continue: true,
          pause: false,
          result: { ...result, approved: true, approvedBy: 'timeout-auto-approve' },
          config,
        };
      case 'reject':
        return {
          continue: false,
          pause: false,
          result: { ...result, approved: false, approvedBy: 'timeout-reject' },
          config,
        };
      case 'block':
      default:
        // Keep blocking (pause workflow)
        return {
          continue: false,
          pause: true,
          result,
          config,
        };
    }
  }

  // Normal approval flow
  if (result.approved) {
    return {
      continue: true,
      pause: false,
      result,
      config,
    };
  }

  // Not approved - pause workflow for manual intervention
  return {
    continue: false,
    pause: true,
    result,
    config,
  };
}

/**
 * Clear all registered gate handlers (useful for testing)
 */
export function clearGateHandlerRegistry(): void {
  gateHandlerRegistry.clear();
}
