/**
 * Core MessageRouter implementation.
 */

import type { MessageEnvelope } from '../types/messages.js';
import type { AgencyConnection, HumancyConnection } from '../types/connections.js';
import type { RouterConfig } from '../types/config.js';
import { ConnectionRegistry } from '../connections/connection-registry.js';
import {
  determineRoute,
  validateMessageForRouting,
  RoutingError,
  DestinationNotFoundError,
  NoRecipientsError,
} from './routing-rules.js';

/** Events emitted by the MessageRouter */
export interface MessageRouterEvents {
  'message:routed': (message: MessageEnvelope, target: string) => void;
  'message:broadcast': (message: MessageEnvelope, recipients: string[]) => void;
  'message:failed': (message: MessageEnvelope, error: Error) => void;
  'message:queued': (message: MessageEnvelope, recipient: string) => void;
}

type EventListener<K extends keyof MessageRouterEvents> = MessageRouterEvents[K];

/** Options for the route method */
export interface RouteOptions {
  /** Skip validation (for internal use) */
  skipValidation?: boolean;

  /** Force queuing even if online */
  forceQueue?: boolean;
}

/**
 * Central message router for Agency <-> Humancy communication.
 */
export class MessageRouter {
  private connectionRegistry: ConnectionRegistry;
  private listeners = new Map<keyof MessageRouterEvents, Set<EventListener<keyof MessageRouterEvents>>>();

  /** Channel routing handler (set by channel system integration) */
  public channelRouter?: (message: MessageEnvelope) => Promise<void>;

  /** Message queue handler (set by persistence layer) */
  public messageQueue?: {
    enqueue: (type: 'agency' | 'humancy', id: string, message: MessageEnvelope) => Promise<void>;
  };

  /** Dead letter queue handler (set by persistence layer) */
  public deadLetterQueue?: {
    add: (message: MessageEnvelope, error: Error) => Promise<void>;
  };

  /** Correlation manager (set by correlation integration) */
  public correlationManager?: {
    correlate: (correlationId: string, response: MessageEnvelope) => boolean;
    waitForCorrelation: (correlationId: string, timeout: number) => Promise<MessageEnvelope>;
  };

  constructor(connectionRegistry?: ConnectionRegistry) {
    this.connectionRegistry = connectionRegistry ?? new ConnectionRegistry();
  }

  // ============ Registration ============

  /** Register an agency connection */
  registerAgency(connection: AgencyConnection): void {
    this.connectionRegistry.registerAgency(connection);

    // Set up message handler for incoming messages
    connection.onMessage(async (message) => {
      try {
        await this.route(message);
      } catch (error) {
        this.emit('message:failed', message, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Register a humancy connection */
  registerHumancy(connection: HumancyConnection): void {
    this.connectionRegistry.registerHumancy(connection);

    // Set up message handler for incoming messages
    connection.onMessage(async (message) => {
      try {
        // Handle correlation for responses
        if (message.type === 'decision_response' && message.correlationId) {
          this.correlationManager?.correlate(message.correlationId, message);
        }

        await this.route(message);
      } catch (error) {
        this.emit('message:failed', message, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Unregister a connection */
  unregister(id: string): void {
    if (this.connectionRegistry.hasAgency(id)) {
      this.connectionRegistry.unregisterAgency(id);
    } else if (this.connectionRegistry.hasHumancy(id)) {
      this.connectionRegistry.unregisterHumancy(id);
    }
  }

  // ============ Routing ============

  /** Route a message to its destination */
  async route(message: MessageEnvelope, options: RouteOptions = {}): Promise<void> {
    if (!options.skipValidation) {
      validateMessageForRouting(message);
    }

    const decision = determineRoute(message);

    switch (decision.target) {
      case 'agency':
        await this.routeToAgency(decision.targetId!, message);
        break;

      case 'humancy':
        await this.routeToHumancy(decision.targetId!, message);
        break;

      case 'broadcast_humancy':
        await this.broadcastToHumancy(message);
        break;

      case 'broadcast_agency':
        await this.broadcastToAgencies(message);
        break;

      case 'channel':
        await this.routeToChannel(decision.targetId!, message);
        break;

      default:
        throw new RoutingError(`Unknown route target: ${decision.target}`, message);
    }
  }

  /** Route message and wait for correlated response */
  async routeAndWait(
    message: MessageEnvelope,
    timeout: number
  ): Promise<MessageEnvelope> {
    if (!this.correlationManager) {
      throw new Error('Correlation manager not configured');
    }

    if (!message.correlationId) {
      throw new RoutingError('routeAndWait requires correlationId', message);
    }

    // Start waiting for correlation before routing
    const responsePromise = this.correlationManager.waitForCorrelation(
      message.correlationId,
      timeout
    );

    // Route the message
    await this.route(message);

    // Wait for response
    return responsePromise;
  }

  // ============ Internal Routing ============

  private async routeToAgency(id: string, message: MessageEnvelope): Promise<void> {
    const sent = await this.connectionRegistry.sendTo('agency', id, message);

    if (sent) {
      this.emit('message:routed', message, `agency:${id}`);
      return;
    }

    // Try to queue if offline
    const registered = this.connectionRegistry.getAgency(id);
    if (!registered) {
      throw new DestinationNotFoundError('agency', id);
    }

    // Queue for offline delivery
    if (this.messageQueue) {
      await this.messageQueue.enqueue('agency', id, message);
      this.emit('message:queued', message, `agency:${id}`);
    } else {
      throw new DestinationNotFoundError('agency', id);
    }
  }

  private async routeToHumancy(id: string, message: MessageEnvelope): Promise<void> {
    const sent = await this.connectionRegistry.sendTo('humancy', id, message);

    if (sent) {
      this.emit('message:routed', message, `humancy:${id}`);
      return;
    }

    // Try to queue if offline
    const registered = this.connectionRegistry.getHumancy(id);
    if (!registered) {
      throw new DestinationNotFoundError('humancy', id);
    }

    // Queue for offline delivery
    if (this.messageQueue) {
      await this.messageQueue.enqueue('humancy', id, message);
      this.emit('message:queued', message, `humancy:${id}`);
    } else {
      throw new DestinationNotFoundError('humancy', id);
    }
  }

  private async routeToChannel(channel: string, message: MessageEnvelope): Promise<void> {
    if (!this.channelRouter) {
      throw new RoutingError('Channel routing not configured', message);
    }

    await this.channelRouter(message);
    this.emit('message:routed', message, `channel:${channel}`);
  }

  // ============ Broadcasting ============

  /** Broadcast message to all online humancy instances */
  async broadcastToHumancy(message: MessageEnvelope): Promise<void> {
    const onlineHumancy = this.connectionRegistry.getOnlineHumancyInstances();

    if (onlineHumancy.length === 0) {
      // No online instances - queue for all registered if persistence available
      const allHumancy = this.connectionRegistry.getAllHumancyInstances();
      if (allHumancy.length === 0) {
        throw new NoRecipientsError('broadcast_humancy');
      }

      if (this.messageQueue) {
        for (const registered of allHumancy) {
          await this.messageQueue.enqueue('humancy', registered.connection.id, message);
        }
        this.emit('message:broadcast', message, allHumancy.map(r => `humancy:${r.connection.id}`));
        return;
      }

      throw new NoRecipientsError('broadcast_humancy');
    }

    const recipients: string[] = [];
    const errors: Error[] = [];

    for (const registered of onlineHumancy) {
      try {
        await registered.connection.send(message);
        recipients.push(`humancy:${registered.connection.id}`);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        // Queue for retry if available
        if (this.messageQueue) {
          await this.messageQueue.enqueue('humancy', registered.connection.id, message);
        }
      }
    }

    if (recipients.length > 0) {
      this.emit('message:broadcast', message, recipients);
    }

    // Also queue for offline instances
    const offlineHumancy = this.connectionRegistry.getAllHumancyInstances()
      .filter(r => r.status === 'offline');

    if (this.messageQueue) {
      for (const registered of offlineHumancy) {
        await this.messageQueue.enqueue('humancy', registered.connection.id, message);
      }
    }
  }

  /** Broadcast message to all online agencies */
  async broadcastToAgencies(message: MessageEnvelope): Promise<void> {
    const onlineAgencies = this.connectionRegistry.getOnlineAgencies();

    if (onlineAgencies.length === 0) {
      // No online instances - queue for all registered if persistence available
      const allAgencies = this.connectionRegistry.getAllAgencies();
      if (allAgencies.length === 0) {
        throw new NoRecipientsError('broadcast_agency');
      }

      if (this.messageQueue) {
        for (const registered of allAgencies) {
          await this.messageQueue.enqueue('agency', registered.connection.id, message);
        }
        this.emit('message:broadcast', message, allAgencies.map(r => `agency:${r.connection.id}`));
        return;
      }

      throw new NoRecipientsError('broadcast_agency');
    }

    const recipients: string[] = [];

    for (const registered of onlineAgencies) {
      try {
        await registered.connection.send(message);
        recipients.push(`agency:${registered.connection.id}`);
      } catch {
        // Queue for retry if available
        if (this.messageQueue) {
          await this.messageQueue.enqueue('agency', registered.connection.id, message);
        }
      }
    }

    if (recipients.length > 0) {
      this.emit('message:broadcast', message, recipients);
    }

    // Also queue for offline instances
    const offlineAgencies = this.connectionRegistry.getAllAgencies()
      .filter(r => r.status === 'offline');

    if (this.messageQueue) {
      for (const registered of offlineAgencies) {
        await this.messageQueue.enqueue('agency', registered.connection.id, message);
      }
    }
  }

  // ============ Event Emitter ============

  /** Add event listener */
  on<K extends keyof MessageRouterEvents>(
    event: K,
    listener: MessageRouterEvents[K]
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<keyof MessageRouterEvents>);
  }

  /** Remove event listener */
  off<K extends keyof MessageRouterEvents>(
    event: K,
    listener: MessageRouterEvents[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener as EventListener<keyof MessageRouterEvents>);
    }
  }

  /** Emit event */
  private emit<K extends keyof MessageRouterEvents>(
    event: K,
    ...args: Parameters<MessageRouterEvents[K]>
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        (listener as (...args: unknown[]) => void)(...args);
      }
    }
  }

  // ============ Getters ============

  /** Get the connection registry */
  getConnectionRegistry(): ConnectionRegistry {
    return this.connectionRegistry;
  }

  /** Get router statistics */
  getStats(): {
    connections: ReturnType<ConnectionRegistry['getStats']>;
  } {
    return {
      connections: this.connectionRegistry.getStats(),
    };
  }

  // ============ Cleanup ============

  /** Close all connections and cleanup */
  async close(): Promise<void> {
    await this.connectionRegistry.closeAll();
    this.listeners.clear();
  }
}
