/**
 * Connection registry for managing Agency and Humancy connections.
 */

import type {
  AgencyConnection,
  HumancyConnection,
  RegisteredConnection,
  ConnectionStatus,
} from '../types/connections.js';
import type { MessageEnvelope } from '../types/messages.js';

/** Events emitted by the ConnectionRegistry */
export interface ConnectionRegistryEvents {
  'agency:registered': (id: string, connection: AgencyConnection) => void;
  'agency:unregistered': (id: string) => void;
  'agency:online': (id: string) => void;
  'agency:offline': (id: string) => void;
  'humancy:registered': (id: string, connection: HumancyConnection) => void;
  'humancy:unregistered': (id: string) => void;
  'humancy:online': (id: string) => void;
  'humancy:offline': (id: string) => void;
}

type EventListener<K extends keyof ConnectionRegistryEvents> = ConnectionRegistryEvents[K];

/** Error thrown when connection already exists */
export class ConnectionExistsError extends Error {
  constructor(type: 'agency' | 'humancy', id: string) {
    super(`${type} connection "${id}" already registered`);
    this.name = 'ConnectionExistsError';
  }
}

/** Error thrown when connection not found */
export class ConnectionNotFoundError extends Error {
  constructor(type: 'agency' | 'humancy', id: string) {
    super(`${type} connection "${id}" not found`);
    this.name = 'ConnectionNotFoundError';
  }
}

/**
 * Registry for managing Agency and Humancy connections.
 * Handles registration, status tracking, and lifecycle events.
 */
export class ConnectionRegistry {
  private agencies = new Map<string, RegisteredConnection<AgencyConnection>>();
  private humancyInstances = new Map<string, RegisteredConnection<HumancyConnection>>();
  private listeners = new Map<keyof ConnectionRegistryEvents, Set<EventListener<keyof ConnectionRegistryEvents>>>();

  /** Callback for delivering queued messages on reconnect (set by persistence layer) */
  public onReconnectDelivery?: (type: 'agency' | 'humancy', id: string) => Promise<void>;

  // ============ Agency Methods ============

  /** Register an agency connection */
  registerAgency(connection: AgencyConnection): void {
    if (this.agencies.has(connection.id)) {
      throw new ConnectionExistsError('agency', connection.id);
    }

    const now = Date.now();
    const registered: RegisteredConnection<AgencyConnection> = {
      connection,
      status: 'online',
      registeredAt: now,
      lastSeenAt: now,
    };

    this.agencies.set(connection.id, registered);

    // Set up disconnect handler
    connection.onDisconnect(() => {
      this.markAgencyOffline(connection.id);
    });

    this.emit('agency:registered', connection.id, connection);
  }

  /** Unregister an agency connection */
  unregisterAgency(id: string): void {
    const registered = this.agencies.get(id);
    if (!registered) {
      throw new ConnectionNotFoundError('agency', id);
    }

    this.agencies.delete(id);
    this.emit('agency:unregistered', id);
  }

  /** Mark an agency as offline */
  markAgencyOffline(id: string): void {
    const registered = this.agencies.get(id);
    if (!registered) {
      return; // Silently ignore if not found (may already be unregistered)
    }

    if (registered.status === 'offline') {
      return; // Already offline
    }

    registered.status = 'offline';
    registered.lastSeenAt = Date.now();
    this.emit('agency:offline', id);
  }

  /** Mark an agency as online and trigger message delivery */
  async markAgencyOnline(id: string): Promise<void> {
    const registered = this.agencies.get(id);
    if (!registered) {
      throw new ConnectionNotFoundError('agency', id);
    }

    if (registered.status === 'online') {
      return; // Already online
    }

    registered.status = 'online';
    registered.lastSeenAt = Date.now();
    this.emit('agency:online', id);

    // Trigger queued message delivery
    if (this.onReconnectDelivery) {
      await this.onReconnectDelivery('agency', id);
    }
  }

  /** Get an agency connection */
  getAgency(id: string): RegisteredConnection<AgencyConnection> | undefined {
    return this.agencies.get(id);
  }

  /** Get all online agency connections */
  getOnlineAgencies(): RegisteredConnection<AgencyConnection>[] {
    return Array.from(this.agencies.values()).filter(r => r.status === 'online');
  }

  /** Get all agency connections */
  getAllAgencies(): RegisteredConnection<AgencyConnection>[] {
    return Array.from(this.agencies.values());
  }

  /** Check if agency is registered */
  hasAgency(id: string): boolean {
    return this.agencies.has(id);
  }

  // ============ Humancy Methods ============

  /** Register a humancy connection */
  registerHumancy(connection: HumancyConnection): void {
    if (this.humancyInstances.has(connection.id)) {
      throw new ConnectionExistsError('humancy', connection.id);
    }

    const now = Date.now();
    const registered: RegisteredConnection<HumancyConnection> = {
      connection,
      status: 'online',
      registeredAt: now,
      lastSeenAt: now,
    };

    this.humancyInstances.set(connection.id, registered);

    // Set up disconnect handler
    connection.onDisconnect(() => {
      this.markHumancyOffline(connection.id);
    });

    this.emit('humancy:registered', connection.id, connection);
  }

  /** Unregister a humancy connection */
  unregisterHumancy(id: string): void {
    const registered = this.humancyInstances.get(id);
    if (!registered) {
      throw new ConnectionNotFoundError('humancy', id);
    }

    this.humancyInstances.delete(id);
    this.emit('humancy:unregistered', id);
  }

  /** Mark a humancy as offline */
  markHumancyOffline(id: string): void {
    const registered = this.humancyInstances.get(id);
    if (!registered) {
      return; // Silently ignore if not found
    }

    if (registered.status === 'offline') {
      return; // Already offline
    }

    registered.status = 'offline';
    registered.lastSeenAt = Date.now();
    this.emit('humancy:offline', id);
  }

  /** Mark a humancy as online and trigger message delivery */
  async markHumancyOnline(id: string): Promise<void> {
    const registered = this.humancyInstances.get(id);
    if (!registered) {
      throw new ConnectionNotFoundError('humancy', id);
    }

    if (registered.status === 'online') {
      return; // Already online
    }

    registered.status = 'online';
    registered.lastSeenAt = Date.now();
    this.emit('humancy:online', id);

    // Trigger queued message delivery
    if (this.onReconnectDelivery) {
      await this.onReconnectDelivery('humancy', id);
    }
  }

  /** Get a humancy connection */
  getHumancy(id: string): RegisteredConnection<HumancyConnection> | undefined {
    return this.humancyInstances.get(id);
  }

  /** Get all online humancy connections */
  getOnlineHumancyInstances(): RegisteredConnection<HumancyConnection>[] {
    return Array.from(this.humancyInstances.values()).filter(r => r.status === 'online');
  }

  /** Get all humancy connections */
  getAllHumancyInstances(): RegisteredConnection<HumancyConnection>[] {
    return Array.from(this.humancyInstances.values());
  }

  /** Check if humancy is registered */
  hasHumancy(id: string): boolean {
    return this.humancyInstances.has(id);
  }

  // ============ Generic Methods ============

  /** Get connection status */
  getStatus(type: 'agency' | 'humancy', id: string): ConnectionStatus | undefined {
    const registered = type === 'agency' ? this.agencies.get(id) : this.humancyInstances.get(id);
    return registered?.status;
  }

  /** Update last seen timestamp */
  updateLastSeen(type: 'agency' | 'humancy', id: string): void {
    const registered = type === 'agency' ? this.agencies.get(id) : this.humancyInstances.get(id);
    if (registered) {
      registered.lastSeenAt = Date.now();
    }
  }

  /** Send message to a specific connection */
  async sendTo(type: 'agency' | 'humancy', id: string, message: MessageEnvelope): Promise<boolean> {
    const registered = type === 'agency' ? this.agencies.get(id) : this.humancyInstances.get(id);
    if (!registered || registered.status !== 'online') {
      return false;
    }

    try {
      await registered.connection.send(message);
      registered.lastSeenAt = Date.now();
      return true;
    } catch {
      // Mark offline on send failure
      if (type === 'agency') {
        this.markAgencyOffline(id);
      } else {
        this.markHumancyOffline(id);
      }
      return false;
    }
  }

  // ============ Event Emitter ============

  /** Add event listener */
  on<K extends keyof ConnectionRegistryEvents>(
    event: K,
    listener: ConnectionRegistryEvents[K]
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<keyof ConnectionRegistryEvents>);
  }

  /** Remove event listener */
  off<K extends keyof ConnectionRegistryEvents>(
    event: K,
    listener: ConnectionRegistryEvents[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener as EventListener<keyof ConnectionRegistryEvents>);
    }
  }

  /** Emit event */
  private emit<K extends keyof ConnectionRegistryEvents>(
    event: K,
    ...args: Parameters<ConnectionRegistryEvents[K]>
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        (listener as (...args: unknown[]) => void)(...args);
      }
    }
  }

  // ============ Cleanup ============

  /** Close all connections and clear registry */
  async closeAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    for (const registered of this.agencies.values()) {
      closePromises.push(registered.connection.close());
    }

    for (const registered of this.humancyInstances.values()) {
      closePromises.push(registered.connection.close());
    }

    await Promise.allSettled(closePromises);

    this.agencies.clear();
    this.humancyInstances.clear();
    this.listeners.clear();
  }

  /** Get registry statistics */
  getStats(): {
    agencies: { total: number; online: number; offline: number };
    humancy: { total: number; online: number; offline: number };
  } {
    const agencyList = Array.from(this.agencies.values());
    const humancyList = Array.from(this.humancyInstances.values());

    return {
      agencies: {
        total: agencyList.length,
        online: agencyList.filter(r => r.status === 'online').length,
        offline: agencyList.filter(r => r.status === 'offline').length,
      },
      humancy: {
        total: humancyList.length,
        online: humancyList.filter(r => r.status === 'online').length,
        offline: humancyList.filter(r => r.status === 'offline').length,
      },
    };
  }
}
