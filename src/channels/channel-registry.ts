/**
 * Channel registry for dynamic channel registration.
 */

import type { Channel, ChannelHandler } from '../types/channels.js';
import {
  isValidChannelName,
  InvalidChannelNameError,
  ChannelExistsError,
  ChannelNotFoundError,
  RESERVED_CHANNEL_NAMES,
} from '../types/channels.js';

/** Events emitted by the ChannelRegistry */
export interface ChannelRegistryEvents {
  'channel:registered': (channel: Channel) => void;
  'channel:unregistered': (name: string) => void;
}

type EventListener<K extends keyof ChannelRegistryEvents> = ChannelRegistryEvents[K];

/**
 * Registry for managing dynamic channel registrations.
 */
export class ChannelRegistry {
  private channels = new Map<string, Channel>();
  private listeners = new Map<keyof ChannelRegistryEvents, Set<EventListener<keyof ChannelRegistryEvents>>>();

  /**
   * Register a new channel.
   *
   * @param name - Channel name (1-64 chars, alphanumeric + underscore)
   * @param handler - Handler function for messages on this channel
   * @param registeredBy - ID of the plugin registering the channel
   * @throws InvalidChannelNameError if name is invalid
   * @throws ChannelExistsError if channel already exists
   */
  register(name: string, handler: ChannelHandler, registeredBy: string): void {
    // Validate channel name
    if (!isValidChannelName(name)) {
      if (RESERVED_CHANNEL_NAMES.includes(name as typeof RESERVED_CHANNEL_NAMES[number])) {
        throw new InvalidChannelNameError(name, 'name is reserved');
      }
      throw new InvalidChannelNameError(
        name,
        'must be 1-64 characters, alphanumeric and underscore only'
      );
    }

    // Check for duplicate
    if (this.channels.has(name)) {
      throw new ChannelExistsError(name);
    }

    const channel: Channel = {
      name,
      handler,
      registeredBy,
      registeredAt: Date.now(),
    };

    this.channels.set(name, channel);
    this.emit('channel:registered', channel);
  }

  /**
   * Unregister a channel.
   *
   * @param name - Channel name
   * @throws ChannelNotFoundError if channel doesn't exist
   */
  unregister(name: string): void {
    if (!this.channels.has(name)) {
      throw new ChannelNotFoundError(name);
    }

    this.channels.delete(name);
    this.emit('channel:unregistered', name);
  }

  /**
   * Get a channel by name.
   */
  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  /**
   * Find a channel (alias for get).
   */
  findChannel(name: string): Channel | undefined {
    return this.get(name);
  }

  /**
   * Check if a channel exists.
   */
  has(name: string): boolean {
    return this.channels.has(name);
  }

  /**
   * Get all registered channels.
   */
  getAll(): Channel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get channels registered by a specific plugin.
   */
  getByRegistrant(registeredBy: string): Channel[] {
    return this.getAll().filter(c => c.registeredBy === registeredBy);
  }

  /**
   * Get channel names.
   */
  getNames(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Get the number of registered channels.
   */
  get size(): number {
    return this.channels.size;
  }

  /**
   * Clear all channels.
   */
  clear(): void {
    const names = this.getNames();
    this.channels.clear();

    for (const name of names) {
      this.emit('channel:unregistered', name);
    }
  }

  // ============ Event Emitter ============

  /** Add event listener */
  on<K extends keyof ChannelRegistryEvents>(
    event: K,
    listener: ChannelRegistryEvents[K]
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<keyof ChannelRegistryEvents>);
  }

  /** Remove event listener */
  off<K extends keyof ChannelRegistryEvents>(
    event: K,
    listener: ChannelRegistryEvents[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener as EventListener<keyof ChannelRegistryEvents>);
    }
  }

  /** Emit event */
  private emit<K extends keyof ChannelRegistryEvents>(
    event: K,
    ...args: Parameters<ChannelRegistryEvents[K]>
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        (listener as (...args: unknown[]) => void)(...args);
      }
    }
  }
}
