import type { PluginEvent } from '../types/events.js';

/**
 * EventBus facet interface
 *
 * This is the contract that event consumers must implement.
 * It's injected into the plugin at runtime.
 */
export interface EventBus {
  /**
   * Emit an event
   * @param event - The event type name
   * @param payload - The event payload
   */
  emit(event: string, payload: unknown): void;

  /**
   * Subscribe to events
   * @param event - The event type name to subscribe to
   * @param handler - The handler function
   * @returns Unsubscribe function
   */
  on(event: string, handler: (payload: unknown) => void): () => void;

  /**
   * Subscribe to events once
   * @param event - The event type name to subscribe to
   * @param handler - The handler function
   */
  once(event: string, handler: (payload: unknown) => void): void;
}

/**
 * Event handler function type
 */
export type EventHandler<T extends PluginEvent = PluginEvent> = (
  event: T
) => void | Promise<void>;

/**
 * Event subscription options
 */
export interface SubscriptionOptions {
  /** Only handle events once then unsubscribe */
  once?: boolean;
}

/**
 * Unsubscribe function returned from event subscriptions
 */
export type Unsubscribe = () => void;

/**
 * Simple in-memory event bus implementation for testing
 */
export class SimpleEventBus implements EventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  emit(event: string, payload: unknown): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`Error in event handler for ${event}:`, error);
        }
      }
    }
  }

  on(event: string, handler: (payload: unknown) => void): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  once(event: string, handler: (payload: unknown) => void): void {
    const wrappedHandler = (payload: unknown) => {
      this.handlers.get(event)?.delete(wrappedHandler);
      handler(payload);
    };
    this.on(event, wrappedHandler);
  }

  /**
   * Remove all handlers (for testing)
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Get the number of handlers for an event (for testing)
   */
  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
