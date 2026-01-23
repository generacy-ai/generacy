/**
 * Debug adapter integration for step execution.
 * Provides hooks for breakpoints, step inspection, and pause/resume functionality.
 */
import type { WorkflowStep, StepResult } from './types';
import type { ActionResult } from './actions/types';

/**
 * Breakpoint definition
 */
export interface Breakpoint {
  /** Unique breakpoint ID */
  id: string;
  /** Phase name to break at (optional, breaks on any phase if not specified) */
  phaseName?: string;
  /** Step name to break at */
  stepName: string;
  /** Whether the breakpoint is enabled */
  enabled: boolean;
  /** Condition expression (optional) */
  condition?: string;
  /** Hit count - breakpoint triggers after this many hits */
  hitCount?: number;
  /** Current hit counter */
  currentHits?: number;
}

/**
 * Step state for inspection
 */
export interface StepState {
  /** Step being executed */
  step: WorkflowStep;
  /** Phase name */
  phaseName: string;
  /** Step index */
  stepIndex: number;
  /** Whether step is paused at breakpoint */
  isPaused: boolean;
  /** Execution start time */
  startTime?: number;
  /** Execution result (available after step completes) */
  result?: StepResult;
  /** Action result (available after action completes) */
  actionResult?: ActionResult;
}

/**
 * Debug hook callbacks
 */
export interface DebugHookCallbacks {
  /** Called before executing a step */
  onBeforeStep?: (state: StepState) => Promise<void>;
  /** Called after executing a step */
  onAfterStep?: (state: StepState) => void;
  /** Called when an error occurs */
  onError?: (state: StepState, error: Error) => void;
  /** Called when pausing at a breakpoint */
  onPause?: (state: StepState, breakpoint: Breakpoint) => void;
  /** Called when resuming from a pause */
  onResume?: (state: StepState) => void;
}

/**
 * Debug hooks class for step execution.
 * Integrates with the debug adapter to provide breakpoints and step inspection.
 */
export class DebugHooks {
  private breakpoints: Map<string, Breakpoint> = new Map();
  private callbacks: DebugHookCallbacks;
  private isPaused = false;
  private pausePromise: Promise<void> | null = null;
  private resumeResolver: (() => void) | null = null;
  private currentState: StepState | null = null;
  private enabled = false;

  constructor(callbacks: DebugHookCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * Enable debug hooks
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Disable debug hooks
   */
  disable(): void {
    this.enabled = false;
    this.resume(); // Resume if paused
  }

  /**
   * Check if debug hooks are enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Add a breakpoint
   */
  addBreakpoint(breakpoint: Breakpoint): void {
    this.breakpoints.set(breakpoint.id, {
      ...breakpoint,
      currentHits: 0,
    });
  }

  /**
   * Remove a breakpoint
   */
  removeBreakpoint(id: string): void {
    this.breakpoints.delete(id);
  }

  /**
   * Enable/disable a breakpoint
   */
  setBreakpointEnabled(id: string, enabled: boolean): void {
    const bp = this.breakpoints.get(id);
    if (bp) {
      bp.enabled = enabled;
    }
  }

  /**
   * Get all breakpoints
   */
  getBreakpoints(): Breakpoint[] {
    return Array.from(this.breakpoints.values());
  }

  /**
   * Clear all breakpoints
   */
  clearBreakpoints(): void {
    this.breakpoints.clear();
  }

  /**
   * Check if currently paused
   */
  getIsPaused(): boolean {
    return this.isPaused;
  }

  /**
   * Get current step state (when paused)
   */
  getCurrentState(): StepState | null {
    return this.currentState;
  }

  /**
   * Hook called before step execution.
   * Checks for breakpoints and pauses if necessary.
   */
  async beforeStep(state: StepState): Promise<void> {
    if (!this.enabled) {
      return;
    }

    this.currentState = state;

    // Check for matching breakpoint
    const breakpoint = this.findMatchingBreakpoint(state);

    if (breakpoint) {
      // Update hit counter
      breakpoint.currentHits = (breakpoint.currentHits || 0) + 1;

      // Check hit count condition
      if (breakpoint.hitCount && breakpoint.currentHits < breakpoint.hitCount) {
        // Not enough hits yet, continue
        return;
      }

      // Pause execution
      state.isPaused = true;
      this.isPaused = true;

      // Notify callback
      this.callbacks.onPause?.(state, breakpoint);

      // Wait for resume
      this.pausePromise = new Promise<void>((resolve) => {
        this.resumeResolver = resolve;
      });

      await this.pausePromise;

      state.isPaused = false;
      this.isPaused = false;

      // Notify resume
      this.callbacks.onResume?.(state);
    }

    // Call before step callback
    await this.callbacks.onBeforeStep?.(state);
  }

  /**
   * Hook called after step execution.
   * Updates state with result and notifies callbacks.
   */
  afterStep(state: StepState, result: StepResult, actionResult?: ActionResult): void {
    if (!this.enabled) {
      return;
    }

    state.result = result;
    state.actionResult = actionResult;
    this.currentState = state;

    // Call after step callback
    this.callbacks.onAfterStep?.(state);
  }

  /**
   * Hook called when an error occurs during step execution.
   */
  onError(state: StepState, error: Error): void {
    if (!this.enabled) {
      return;
    }

    this.currentState = state;
    this.callbacks.onError?.(state, error);
  }

  /**
   * Resume execution when paused at a breakpoint.
   */
  resume(): void {
    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = null;
      this.pausePromise = null;
    }
  }

  /**
   * Step over - resume and pause at next step.
   * Creates a temporary breakpoint for the next step.
   */
  stepOver(): void {
    // Resume current pause
    this.resume();
    // Note: The executor should handle stepping logic by creating
    // a temporary breakpoint for the next step
  }

  /**
   * Find a matching breakpoint for the current step
   */
  private findMatchingBreakpoint(state: StepState): Breakpoint | undefined {
    for (const bp of this.breakpoints.values()) {
      if (!bp.enabled) {
        continue;
      }

      // Check step name match
      if (bp.stepName !== state.step.name) {
        continue;
      }

      // Check phase name match (if specified)
      if (bp.phaseName && bp.phaseName !== state.phaseName) {
        continue;
      }

      // Check condition (if specified)
      if (bp.condition) {
        // Simple condition evaluation - could be extended
        // For now, just check if condition is truthy
        try {
          if (!bp.condition.trim() || bp.condition === 'false' || bp.condition === '0') {
            continue;
          }
        } catch {
          // Condition evaluation failed, skip this breakpoint
          continue;
        }
      }

      return bp;
    }

    return undefined;
  }

  /**
   * Update callbacks
   */
  setCallbacks(callbacks: DebugHookCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Create a step state object
   */
  static createStepState(
    step: WorkflowStep,
    phaseName: string,
    stepIndex: number
  ): StepState {
    return {
      step,
      phaseName,
      stepIndex,
      isPaused: false,
    };
  }
}

/**
 * Global debug hooks instance for the runner
 */
let globalDebugHooks: DebugHooks | undefined;

/**
 * Get or create the global debug hooks instance
 */
export function getDebugHooks(): DebugHooks {
  if (!globalDebugHooks) {
    globalDebugHooks = new DebugHooks();
  }
  return globalDebugHooks;
}

/**
 * Set the global debug hooks instance (for testing)
 */
export function setDebugHooks(hooks: DebugHooks | undefined): void {
  globalDebugHooks = hooks;
}

/**
 * Reset the global debug hooks instance
 */
export function resetDebugHooks(): void {
  if (globalDebugHooks) {
    globalDebugHooks.disable();
    globalDebugHooks.clearBreakpoints();
  }
  globalDebugHooks = undefined;
}
