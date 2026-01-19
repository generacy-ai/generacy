/**
 * Event types and emitter utilities for the scheduler.
 */

import type { Job } from './types.js';

/**
 * Metrics snapshot emitted periodically.
 */
export interface SchedulerMetrics {
  /** Snapshot timestamp (Unix ms) */
  timestamp: number;

  /** Queue depth by priority */
  queueDepth: {
    high: number;
    normal: number;
    low: number;
    total: number;
  };

  /** Currently processing jobs */
  processing: number;

  /** Jobs in dead letter queue */
  deadLetter: number;

  /** Jobs completed in last minute */
  completedLastMinute: number;

  /** Jobs failed in last minute */
  failedLastMinute: number;

  /** Average processing time (ms) */
  avgProcessingTimeMs: number;
}

/**
 * Events emitted by the scheduler.
 */
export interface SchedulerEvents {
  /** Job was added to the queue */
  'job:enqueued': (job: Job) => void;

  /** Job processing has started */
  'job:started': (job: Job) => void;

  /** Job completed successfully */
  'job:completed': (job: Job, result: unknown) => void;

  /** Job processing failed (may retry) */
  'job:failed': (job: Job, error: Error) => void;

  /** Job moved to dead letter queue */
  'job:dead': (job: Job) => void;

  /** Periodic metrics snapshot */
  'metrics:snapshot': (metrics: SchedulerMetrics) => void;
}

/** Event names for the scheduler */
export const SCHEDULER_EVENT_NAMES = [
  'job:enqueued',
  'job:started',
  'job:completed',
  'job:failed',
  'job:dead',
  'metrics:snapshot',
] as const;

export type SchedulerEventName = keyof SchedulerEvents;

type EventListener<K extends keyof SchedulerEvents> = SchedulerEvents[K];

/**
 * Typed event emitter mixin for scheduler classes.
 */
export class SchedulerEventEmitter {
  private listeners = new Map<SchedulerEventName, Set<EventListener<SchedulerEventName>>>();

  /** Add event listener */
  on<K extends keyof SchedulerEvents>(event: K, listener: SchedulerEvents[K]): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<SchedulerEventName>);
  }

  /** Remove event listener */
  off<K extends keyof SchedulerEvents>(event: K, listener: SchedulerEvents[K]): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener as EventListener<SchedulerEventName>);
    }
  }

  /** Emit an event */
  protected emit<K extends keyof SchedulerEvents>(
    event: K,
    ...args: Parameters<SchedulerEvents[K]>
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        (listener as (...args: unknown[]) => void)(...args);
      }
    }
  }

  /** Remove all listeners */
  removeAllListeners(): void {
    this.listeners.clear();
  }
}
