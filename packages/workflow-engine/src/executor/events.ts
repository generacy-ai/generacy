/**
 * Event emission system for workflow execution.
 * Provides typed event emission and subscription.
 */
import type {
  ExecutionEvent,
  ExecutionEventListener,
  ExecutionEventType,
} from '../types/events.js';

/**
 * Event emitter for workflow execution
 */
export class ExecutionEventEmitter {
  private listeners = new Set<ExecutionEventListener>();

  /**
   * Add an event listener
   * @param listener The listener function
   * @returns Disposable to remove the listener
   */
  addEventListener(listener: ExecutionEventListener): { dispose: () => void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Remove an event listener
   * @param listener The listener to remove
   */
  removeEventListener(listener: ExecutionEventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Remove all listeners
   */
  removeAllListeners(): void {
    this.listeners.clear();
  }

  /**
   * Emit an event to all listeners
   * @param event The event to emit
   */
  emit(event: ExecutionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Execution event listener error:', error);
      }
    }
  }

  /**
   * Create and emit an event
   * @param type The event type
   * @param workflowName The workflow name
   * @param options Additional event options
   */
  emitEvent(
    type: ExecutionEventType,
    workflowName: string,
    options?: {
      phaseName?: string;
      stepName?: string;
      message?: string;
      data?: unknown;
    }
  ): void {
    this.emit({
      type,
      timestamp: Date.now(),
      workflowName,
      ...options,
    });
  }
}

/**
 * Create execution event
 */
export function createExecutionEvent(
  type: ExecutionEventType,
  workflowName: string,
  options?: {
    phaseName?: string;
    stepName?: string;
    message?: string;
    data?: unknown;
  }
): ExecutionEvent {
  return {
    type,
    timestamp: Date.now(),
    workflowName,
    ...options,
  };
}
