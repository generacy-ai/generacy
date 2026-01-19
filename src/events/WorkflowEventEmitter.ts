/**
 * Workflow Event Emitter
 *
 * Typed event emitter for workflow events.
 */

import type {
  WorkflowEvent,
  WorkflowEventType,
  WorkflowEventHandler,
  WorkflowEventPayload,
} from '../types/WorkflowEvent.js';
import { createWorkflowEvent } from '../types/WorkflowEvent.js';

/**
 * Event emitter for workflow events.
 * Supports subscribing to all events or specific event types.
 */
export class WorkflowEventEmitter {
  private handlers: Set<WorkflowEventHandler> = new Set();
  private typeHandlers: Map<WorkflowEventType, Set<WorkflowEventHandler>> = new Map();

  /**
   * Subscribe to all workflow events.
   * @param handler Event handler callback
   * @returns Unsubscribe function
   */
  onEvent(handler: WorkflowEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Subscribe to a specific event type.
   * @param type Event type to subscribe to
   * @param handler Event handler callback
   * @returns Unsubscribe function
   */
  on(type: WorkflowEventType, handler: WorkflowEventHandler): () => void {
    if (!this.typeHandlers.has(type)) {
      this.typeHandlers.set(type, new Set());
    }
    this.typeHandlers.get(type)!.add(handler);

    return () => {
      this.typeHandlers.get(type)?.delete(handler);
    };
  }

  /**
   * Subscribe to multiple event types.
   * @param types Array of event types to subscribe to
   * @param handler Event handler callback
   * @returns Unsubscribe function
   */
  onMany(types: WorkflowEventType[], handler: WorkflowEventHandler): () => void {
    const unsubscribers = types.map((type) => this.on(type, handler));

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }

  /**
   * Emit an event to all subscribers.
   * @param event The event to emit
   */
  emit(event: WorkflowEvent): void {
    // Emit to global handlers
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('Error in event handler:', error);
      }
    }

    // Emit to type-specific handlers
    const typeSet = this.typeHandlers.get(event.type);
    if (typeSet) {
      for (const handler of typeSet) {
        try {
          handler(event);
        } catch (error) {
          console.error('Error in event handler:', error);
        }
      }
    }
  }

  /**
   * Create and emit a workflow event.
   * @param type Event type
   * @param workflowId Workflow instance ID
   * @param workflowName Workflow definition name
   * @param payload Event payload
   */
  emitEvent<T extends WorkflowEventPayload>(
    type: WorkflowEventType,
    workflowId: string,
    workflowName: string,
    payload: T
  ): void {
    const event = createWorkflowEvent(type, workflowId, workflowName, payload);
    this.emit(event);
  }

  /**
   * Remove all event handlers.
   */
  clear(): void {
    this.handlers.clear();
    this.typeHandlers.clear();
  }

  /**
   * Get the count of registered handlers.
   */
  get handlerCount(): number {
    let count = this.handlers.size;
    for (const set of this.typeHandlers.values()) {
      count += set.size;
    }
    return count;
  }
}
