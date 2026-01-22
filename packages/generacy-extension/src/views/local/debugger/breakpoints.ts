/**
 * Breakpoint management for Generacy workflow debugging.
 * Supports breakpoints on phases and steps with conditional expressions.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils';

/**
 * Location type for breakpoints
 */
export type BreakpointLocationType = 'phase' | 'step';

/**
 * Breakpoint location in a workflow
 */
export interface BreakpointLocation {
  /** Type of location (phase or step) */
  type: BreakpointLocationType;
  /** Phase name */
  phaseName: string;
  /** Step name (only for step breakpoints) */
  stepName?: string;
  /** Line number in the source file */
  line: number;
}

/**
 * Breakpoint definition
 */
export interface WorkflowBreakpoint {
  /** Unique breakpoint ID */
  id: number;
  /** Source file URI */
  uri: vscode.Uri;
  /** Location in the workflow */
  location: BreakpointLocation;
  /** Whether the breakpoint is enabled */
  enabled: boolean;
  /** Condition expression (for conditional breakpoints) */
  condition?: string;
  /** Hit condition (e.g., ">=3" for hit count breakpoints) */
  hitCondition?: string;
  /** Log message (for logpoints) */
  logMessage?: string;
  /** Whether this breakpoint has been verified/validated */
  verified: boolean;
  /** Current hit count */
  hitCount: number;
}

/**
 * Breakpoint event types
 */
export type BreakpointEventType = 'added' | 'removed' | 'changed' | 'hit' | 'verified';

/**
 * Breakpoint event
 */
export interface BreakpointEvent {
  type: BreakpointEventType;
  breakpoint: WorkflowBreakpoint;
  reason?: string;
}

/**
 * Breakpoint event listener
 */
export type BreakpointEventListener = (event: BreakpointEvent) => void;

/**
 * Breakpoint manager for workflow debugging.
 * Manages breakpoints across workflow files and provides
 * utilities for checking if execution should pause.
 */
export class BreakpointManager {
  private static instance: BreakpointManager | undefined;
  private breakpoints: Map<number, WorkflowBreakpoint> = new Map();
  private nextId = 1;
  private listeners: Set<BreakpointEventListener> = new Set();
  private readonly _onDidChangeBreakpoints = new vscode.EventEmitter<void>();
  public readonly onDidChangeBreakpoints = this._onDidChangeBreakpoints.event;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): BreakpointManager {
    if (!BreakpointManager.instance) {
      BreakpointManager.instance = new BreakpointManager();
    }
    return BreakpointManager.instance;
  }

  /**
   * Add a breakpoint event listener
   */
  public addEventListener(listener: BreakpointEventListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /**
   * Add a breakpoint
   */
  public addBreakpoint(
    uri: vscode.Uri,
    location: BreakpointLocation,
    options?: {
      condition?: string;
      hitCondition?: string;
      logMessage?: string;
    }
  ): WorkflowBreakpoint {
    const logger = getLogger();

    const breakpoint: WorkflowBreakpoint = {
      id: this.nextId++,
      uri,
      location,
      enabled: true,
      condition: options?.condition,
      hitCondition: options?.hitCondition,
      logMessage: options?.logMessage,
      verified: false,
      hitCount: 0,
    };

    this.breakpoints.set(breakpoint.id, breakpoint);
    logger.debug(`Added breakpoint #${breakpoint.id}`, {
      type: location.type,
      phase: location.phaseName,
      step: location.stepName,
    });

    this.emitEvent({ type: 'added', breakpoint });
    this._onDidChangeBreakpoints.fire();

    return breakpoint;
  }

  /**
   * Remove a breakpoint by ID
   */
  public removeBreakpoint(id: number): boolean {
    const breakpoint = this.breakpoints.get(id);
    if (!breakpoint) {
      return false;
    }

    this.breakpoints.delete(id);
    const logger = getLogger();
    logger.debug(`Removed breakpoint #${id}`);

    this.emitEvent({ type: 'removed', breakpoint });
    this._onDidChangeBreakpoints.fire();

    return true;
  }

  /**
   * Remove all breakpoints for a specific URI
   */
  public removeBreakpointsForUri(uri: vscode.Uri): number {
    let count = 0;
    const toRemove: number[] = [];

    for (const [id, bp] of this.breakpoints) {
      if (bp.uri.toString() === uri.toString()) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.removeBreakpoint(id);
      count++;
    }

    return count;
  }

  /**
   * Clear all breakpoints
   */
  public clearAllBreakpoints(): void {
    const logger = getLogger();
    const count = this.breakpoints.size;

    for (const breakpoint of this.breakpoints.values()) {
      this.emitEvent({ type: 'removed', breakpoint });
    }

    this.breakpoints.clear();
    logger.debug(`Cleared ${count} breakpoints`);
    this._onDidChangeBreakpoints.fire();
  }

  /**
   * Get a breakpoint by ID
   */
  public getBreakpoint(id: number): WorkflowBreakpoint | undefined {
    return this.breakpoints.get(id);
  }

  /**
   * Get all breakpoints
   */
  public getAllBreakpoints(): WorkflowBreakpoint[] {
    return Array.from(this.breakpoints.values());
  }

  /**
   * Get breakpoints for a specific URI
   */
  public getBreakpointsForUri(uri: vscode.Uri): WorkflowBreakpoint[] {
    const result: WorkflowBreakpoint[] = [];
    for (const bp of this.breakpoints.values()) {
      if (bp.uri.toString() === uri.toString()) {
        result.push(bp);
      }
    }
    return result;
  }

  /**
   * Get breakpoints for a specific line
   */
  public getBreakpointsForLine(uri: vscode.Uri, line: number): WorkflowBreakpoint[] {
    return this.getBreakpointsForUri(uri).filter(bp => bp.location.line === line);
  }

  /**
   * Set breakpoints for a URI from DAP request (replaces existing breakpoints)
   */
  public setBreakpointsForUri(
    uri: vscode.Uri,
    breakpoints: Array<{
      line: number;
      condition?: string;
      hitCondition?: string;
      logMessage?: string;
    }>,
    locationResolver: (line: number) => BreakpointLocation | undefined
  ): WorkflowBreakpoint[] {
    // Remove existing breakpoints for this URI
    this.removeBreakpointsForUri(uri);

    // Add new breakpoints
    const result: WorkflowBreakpoint[] = [];
    for (const bp of breakpoints) {
      const location = locationResolver(bp.line);
      if (location) {
        const newBp = this.addBreakpoint(uri, location, {
          condition: bp.condition,
          hitCondition: bp.hitCondition,
          logMessage: bp.logMessage,
        });
        // Mark as verified since we resolved the location
        newBp.verified = true;
        this.emitEvent({ type: 'verified', breakpoint: newBp });
        result.push(newBp);
      }
    }

    return result;
  }

  /**
   * Enable or disable a breakpoint
   */
  public setBreakpointEnabled(id: number, enabled: boolean): boolean {
    const breakpoint = this.breakpoints.get(id);
    if (!breakpoint) {
      return false;
    }

    if (breakpoint.enabled !== enabled) {
      breakpoint.enabled = enabled;
      this.emitEvent({ type: 'changed', breakpoint });
      this._onDidChangeBreakpoints.fire();
    }

    return true;
  }

  /**
   * Update breakpoint condition
   */
  public setBreakpointCondition(id: number, condition: string | undefined): boolean {
    const breakpoint = this.breakpoints.get(id);
    if (!breakpoint) {
      return false;
    }

    breakpoint.condition = condition;
    this.emitEvent({ type: 'changed', breakpoint });
    this._onDidChangeBreakpoints.fire();

    return true;
  }

  /**
   * Check if execution should stop at a given location
   * Returns the breakpoint if it should stop, undefined otherwise
   */
  public shouldStopAt(
    uri: vscode.Uri,
    phaseName: string,
    stepName?: string,
    context?: Record<string, unknown>
  ): WorkflowBreakpoint | undefined {
    const breakpoints = this.getBreakpointsForUri(uri);

    for (const bp of breakpoints) {
      if (!bp.enabled) {
        continue;
      }

      // Check if location matches
      const locationMatches = this.locationMatches(bp.location, phaseName, stepName);
      if (!locationMatches) {
        continue;
      }

      // Increment hit count
      bp.hitCount++;

      // Check hit condition
      if (bp.hitCondition && !this.evaluateHitCondition(bp.hitCondition, bp.hitCount)) {
        continue;
      }

      // Check condition
      if (bp.condition && !this.evaluateCondition(bp.condition, context)) {
        continue;
      }

      // Handle logpoint
      if (bp.logMessage) {
        this.logMessage(bp.logMessage, context);
        continue; // Logpoints don't stop execution
      }

      // Breakpoint hit!
      this.emitEvent({ type: 'hit', breakpoint: bp });
      return bp;
    }

    return undefined;
  }

  /**
   * Check if a location matches a breakpoint
   */
  private locationMatches(
    location: BreakpointLocation,
    phaseName: string,
    stepName?: string
  ): boolean {
    if (location.phaseName !== phaseName) {
      return false;
    }

    if (location.type === 'phase') {
      // Phase breakpoints match at the start of a phase (before any step)
      return stepName === undefined;
    }

    // Step breakpoints match specific steps
    return location.stepName === stepName;
  }

  /**
   * Evaluate a condition expression
   */
  private evaluateCondition(condition: string, context?: Record<string, unknown>): boolean {
    try {
      // Simple expression evaluation
      // In a full implementation, this would be a proper expression evaluator
      if (!context) {
        return true;
      }

      const trimmed = condition.trim();

      // Check if condition is a simple variable lookup
      if (trimmed in context) {
        const value = context[trimmed];
        return Boolean(value);
      }

      // Replace variable references with context values
      let evaluated = trimmed;
      for (const [key, value] of Object.entries(context)) {
        // Replace ${key} or $key patterns
        const regex = new RegExp(`\\$\\{?${key}\\}?`, 'g');
        evaluated = evaluated.replace(regex, JSON.stringify(value));
      }

      // Simple evaluations
      if (evaluated === 'true') return true;
      if (evaluated === 'false') return false;

      // Try to evaluate as JavaScript (basic comparisons)
      // This is a simplified implementation
      const comparisons = evaluated.match(/^(.+?)\s*(===?|!==?|>=?|<=?)\s*(.+)$/);
      if (comparisons) {
        const left = this.parseValue(comparisons[1]?.trim() ?? '');
        const operator = comparisons[2];
        const right = this.parseValue(comparisons[3]?.trim() ?? '');

        switch (operator) {
          case '==':
          case '===':
            return left === right;
          case '!=':
          case '!==':
            return left !== right;
          case '>':
            return left > right;
          case '>=':
            return left >= right;
          case '<':
            return left < right;
          case '<=':
            return left <= right;
        }
      }

      return true; // Default to true for unrecognized expressions
    } catch {
      return true; // Default to true on evaluation error
    }
  }

  /**
   * Parse a value from a condition string
   */
  private parseValue(str: string): unknown {
    // Try number
    const num = Number(str);
    if (!isNaN(num)) {
      return num;
    }

    // Try boolean
    if (str === 'true') return true;
    if (str === 'false') return false;
    if (str === 'null') return null;
    if (str === 'undefined') return undefined;

    // Try JSON
    try {
      return JSON.parse(str);
    } catch {
      // Return as string (strip quotes if present)
      return str.replace(/^['"]|['"]$/g, '');
    }
  }

  /**
   * Evaluate a hit condition
   */
  private evaluateHitCondition(hitCondition: string, hitCount: number): boolean {
    try {
      const trimmed = hitCondition.trim();

      // Just a number means "stop when hit count equals this number"
      const justNumber = Number(trimmed);
      if (!isNaN(justNumber)) {
        return hitCount === justNumber;
      }

      // Parse comparison operators
      const match = trimmed.match(/^(>=?|<=?|===?|!==?|%)\s*(\d+)$/);
      if (match) {
        const operator = match[1];
        const value = Number(match[2]);

        switch (operator) {
          case '>':
            return hitCount > value;
          case '>=':
            return hitCount >= value;
          case '<':
            return hitCount < value;
          case '<=':
            return hitCount <= value;
          case '==':
          case '===':
            return hitCount === value;
          case '!=':
          case '!==':
            return hitCount !== value;
          case '%':
            return hitCount % value === 0;
        }
      }

      return true;
    } catch {
      return true;
    }
  }

  /**
   * Log a message (for logpoints)
   */
  private logMessage(message: string, context?: Record<string, unknown>): void {
    const logger = getLogger();

    // Replace variable references in log message
    let output = message;
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        const regex = new RegExp(`\\{${key}\\}`, 'g');
        output = output.replace(regex, String(value));
      }
    }

    logger.info(`[Logpoint] ${output}`);
  }

  /**
   * Emit a breakpoint event
   */
  private emitEvent(event: BreakpointEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Breakpoint event listener error:', error);
      }
    }
  }

  /**
   * Verify breakpoints against a workflow document
   */
  public verifyBreakpoints(
    uri: vscode.Uri,
    locations: Array<{ line: number; phaseName: string; stepName?: string }>
  ): void {
    const breakpoints = this.getBreakpointsForUri(uri);

    for (const bp of breakpoints) {
      // Find matching location
      const match = locations.find(loc =>
        loc.phaseName === bp.location.phaseName &&
        loc.stepName === bp.location.stepName
      );

      if (match) {
        bp.verified = true;
        bp.location.line = match.line;
        this.emitEvent({ type: 'verified', breakpoint: bp });
      } else {
        bp.verified = false;
        this.emitEvent({ type: 'changed', breakpoint: bp, reason: 'unverified' });
      }
    }

    this._onDidChangeBreakpoints.fire();
  }

  /**
   * Reset hit counts for all breakpoints
   */
  public resetHitCounts(): void {
    for (const bp of this.breakpoints.values()) {
      bp.hitCount = 0;
    }
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.breakpoints.clear();
    this.listeners.clear();
    this._onDidChangeBreakpoints.dispose();
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    BreakpointManager.instance?.dispose();
    BreakpointManager.instance = undefined;
  }
}

/**
 * Get the singleton breakpoint manager instance
 */
export function getBreakpointManager(): BreakpointManager {
  return BreakpointManager.getInstance();
}
