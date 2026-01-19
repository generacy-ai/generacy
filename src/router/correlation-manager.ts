/**
 * Correlation manager for tracking request/response pairs.
 */

import type { MessageEnvelope } from '../types/messages.js';

/** Error thrown when correlation times out */
export class CorrelationTimeoutError extends Error {
  constructor(public readonly correlationId: string) {
    super(`Correlation timeout for ${correlationId}`);
    this.name = 'CorrelationTimeoutError';
  }
}

/** Error thrown when correlation is cancelled */
export class CorrelationCancelledError extends Error {
  constructor(public readonly correlationId: string) {
    super(`Correlation cancelled for ${correlationId}`);
    this.name = 'CorrelationCancelledError';
  }
}

/** Pending correlation entry */
interface PendingCorrelation {
  /** Original request message */
  request: MessageEnvelope;

  /** When the request was sent */
  sentAt: number;

  /** Timeout deadline */
  deadline: number;

  /** Promise resolver */
  resolve: (response: MessageEnvelope) => void;

  /** Promise rejecter */
  reject: (error: Error) => void;

  /** Timeout handle */
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/** Events emitted by the CorrelationManager */
export interface CorrelationManagerEvents {
  'correlation:started': (correlationId: string, request: MessageEnvelope) => void;
  'correlation:completed': (correlationId: string, request: MessageEnvelope, response: MessageEnvelope) => void;
  'correlation:timeout': (correlationId: string, request: MessageEnvelope) => void;
  'correlation:cancelled': (correlationId: string) => void;
}

type EventListener<K extends keyof CorrelationManagerEvents> = CorrelationManagerEvents[K];

/**
 * Manages correlation tracking for request/response message pairs.
 * Handles timeouts and ensures responses are matched to their requests.
 */
export class CorrelationManager {
  private pending = new Map<string, PendingCorrelation>();
  private listeners = new Map<keyof CorrelationManagerEvents, Set<EventListener<keyof CorrelationManagerEvents>>>();

  /**
   * Wait for a correlated response to a request.
   *
   * @param correlationId - The correlation ID to wait for
   * @param timeout - Timeout in milliseconds
   * @returns Promise that resolves with the response message
   * @throws CorrelationTimeoutError if timeout is reached
   */
  waitForCorrelation(
    correlationId: string,
    timeout: number
  ): Promise<MessageEnvelope> {
    // Check if already pending
    if (this.pending.has(correlationId)) {
      return Promise.reject(new Error(`Correlation ${correlationId} is already pending`));
    }

    return new Promise<MessageEnvelope>((resolve, reject) => {
      const now = Date.now();

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        const pending = this.pending.get(correlationId);
        if (pending) {
          this.pending.delete(correlationId);
          this.emit('correlation:timeout', correlationId, pending.request);
          reject(new CorrelationTimeoutError(correlationId));
        }
      }, timeout);

      // Store pending correlation
      const pending: PendingCorrelation = {
        request: {} as MessageEnvelope, // Will be set by setRequest
        sentAt: now,
        deadline: now + timeout,
        resolve,
        reject,
        timeoutHandle,
      };

      this.pending.set(correlationId, pending);
    });
  }

  /**
   * Sets the request message for a pending correlation.
   * Should be called after waitForCorrelation and before sending the request.
   */
  setRequest(correlationId: string, request: MessageEnvelope): void {
    const pending = this.pending.get(correlationId);
    if (pending) {
      pending.request = request;
      this.emit('correlation:started', correlationId, request);
    }
  }

  /**
   * Creates a correlation and immediately associates a request with it.
   * Convenience method that combines waitForCorrelation and setRequest.
   */
  async waitForResponse(
    request: MessageEnvelope,
    timeout: number
  ): Promise<MessageEnvelope> {
    if (!request.correlationId) {
      throw new Error('Request must have a correlationId');
    }

    const correlationId = request.correlationId;

    // Check if already pending
    if (this.pending.has(correlationId)) {
      throw new Error(`Correlation ${correlationId} is already pending`);
    }

    return new Promise<MessageEnvelope>((resolve, reject) => {
      const now = Date.now();

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        const pending = this.pending.get(correlationId);
        if (pending) {
          this.pending.delete(correlationId);
          this.emit('correlation:timeout', correlationId, request);
          reject(new CorrelationTimeoutError(correlationId));
        }
      }, timeout);

      // Store pending correlation with request
      const pending: PendingCorrelation = {
        request,
        sentAt: now,
        deadline: now + timeout,
        resolve,
        reject,
        timeoutHandle,
      };

      this.pending.set(correlationId, pending);
      this.emit('correlation:started', correlationId, request);
    });
  }

  /**
   * Correlate a response with a pending request.
   *
   * @param correlationId - The correlation ID from the response
   * @param response - The response message
   * @returns true if correlation was found and resolved, false otherwise
   */
  correlate(correlationId: string, response: MessageEnvelope): boolean {
    const pending = this.pending.get(correlationId);
    if (!pending) {
      return false;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeoutHandle);
    this.pending.delete(correlationId);

    // Emit event and resolve
    this.emit('correlation:completed', correlationId, pending.request, response);
    pending.resolve(response);

    return true;
  }

  /**
   * Cancel a pending correlation.
   */
  cancel(correlationId: string): boolean {
    const pending = this.pending.get(correlationId);
    if (!pending) {
      return false;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeoutHandle);
    this.pending.delete(correlationId);

    // Emit event and reject
    this.emit('correlation:cancelled', correlationId);
    pending.reject(new CorrelationCancelledError(correlationId));

    return true;
  }

  /**
   * Check if a correlation is pending.
   */
  isPending(correlationId: string): boolean {
    return this.pending.has(correlationId);
  }

  /**
   * Get the number of pending correlations.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Get pending correlation info (for debugging/monitoring).
   */
  getPendingInfo(): Array<{
    correlationId: string;
    requestId: string;
    sentAt: number;
    deadline: number;
    remainingMs: number;
  }> {
    const now = Date.now();
    return Array.from(this.pending.entries()).map(([correlationId, pending]) => ({
      correlationId,
      requestId: pending.request.id,
      sentAt: pending.sentAt,
      deadline: pending.deadline,
      remainingMs: Math.max(0, pending.deadline - now),
    }));
  }

  /**
   * Cancel all pending correlations.
   */
  cancelAll(): void {
    for (const [correlationId, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      this.emit('correlation:cancelled', correlationId);
      pending.reject(new CorrelationCancelledError(correlationId));
    }
    this.pending.clear();
  }

  // ============ Event Emitter ============

  /** Add event listener */
  on<K extends keyof CorrelationManagerEvents>(
    event: K,
    listener: CorrelationManagerEvents[K]
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<keyof CorrelationManagerEvents>);
  }

  /** Remove event listener */
  off<K extends keyof CorrelationManagerEvents>(
    event: K,
    listener: CorrelationManagerEvents[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener as EventListener<keyof CorrelationManagerEvents>);
    }
  }

  /** Emit event */
  private emit<K extends keyof CorrelationManagerEvents>(
    event: K,
    ...args: Parameters<CorrelationManagerEvents[K]>
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        (listener as (...args: unknown[]) => void)(...args);
      }
    }
  }
}
