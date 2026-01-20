import type WebSocket from 'ws';
import type {
  Channel,
  ClientSubscription,
  SubscriptionFilters,
  ServerMessage,
  WorkflowEventMessage,
} from '../types/index.js';
import { serializeServerMessage } from './messages.js';

/**
 * Subscription manager for WebSocket channels
 */
export class SubscriptionManager {
  private subscriptions: Map<WebSocket, ClientSubscription> = new Map();
  private channelSubscribers: Map<Channel, Set<WebSocket>> = new Map();

  constructor() {
    // Initialize channel sets
    this.channelSubscribers.set('workflows', new Set());
    this.channelSubscribers.set('queue', new Set());
    this.channelSubscribers.set('agents', new Set());
  }

  /**
   * Subscribe a client to channels
   */
  subscribe(ws: WebSocket, channels: Channel[], filters?: SubscriptionFilters): void {
    // Get or create subscription
    let subscription = this.subscriptions.get(ws);
    if (!subscription) {
      subscription = {
        channels: new Set(),
        filters: filters || {},
      };
      this.subscriptions.set(ws, subscription);
    }

    // Update filters if provided
    if (filters) {
      subscription.filters = { ...subscription.filters, ...filters };
    }

    // Add to channels
    for (const channel of channels) {
      subscription.channels.add(channel);
      this.channelSubscribers.get(channel)?.add(ws);
    }
  }

  /**
   * Unsubscribe a client from channels
   */
  unsubscribe(ws: WebSocket, channels: Channel[]): void {
    const subscription = this.subscriptions.get(ws);
    if (!subscription) return;

    for (const channel of channels) {
      subscription.channels.delete(channel);
      this.channelSubscribers.get(channel)?.delete(ws);
    }

    // Remove subscription if no channels left
    if (subscription.channels.size === 0) {
      this.subscriptions.delete(ws);
    }
  }

  /**
   * Remove all subscriptions for a client
   */
  removeClient(ws: WebSocket): void {
    const subscription = this.subscriptions.get(ws);
    if (!subscription) return;

    // Remove from all channel sets
    for (const channel of subscription.channels) {
      this.channelSubscribers.get(channel)?.delete(ws);
    }

    this.subscriptions.delete(ws);
  }

  /**
   * Get subscription for a client
   */
  getSubscription(ws: WebSocket): ClientSubscription | undefined {
    return this.subscriptions.get(ws);
  }

  /**
   * Get all subscribers for a channel
   */
  getChannelSubscribers(channel: Channel): Set<WebSocket> {
    return this.channelSubscribers.get(channel) || new Set();
  }

  /**
   * Broadcast message to all subscribers of a channel
   */
  broadcast(channel: Channel, message: ServerMessage): void {
    const subscribers = this.getChannelSubscribers(channel);
    const serialized = serializeServerMessage(message);

    for (const ws of subscribers) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(serialized);
      }
    }
  }

  /**
   * Broadcast message with filter matching
   */
  broadcastFiltered(
    channel: Channel,
    message: ServerMessage,
    matcher: (filters: SubscriptionFilters) => boolean
  ): void {
    const subscribers = this.getChannelSubscribers(channel);
    const serialized = serializeServerMessage(message);

    for (const ws of subscribers) {
      if (ws.readyState !== 1) continue; // WebSocket.OPEN

      const subscription = this.subscriptions.get(ws);
      if (!subscription) continue;

      // Apply filter matching
      if (matcher(subscription.filters)) {
        ws.send(serialized);
      }
    }
  }

  /**
   * Broadcast workflow event with filter matching
   */
  broadcastWorkflowEvent(message: WorkflowEventMessage): void {
    this.broadcastFiltered('workflows', message, (filters) => {
      // No filters = receive all
      if (!filters.workflowId && (!filters.tags || filters.tags.length === 0)) {
        return true;
      }

      // Match workflow ID
      if (filters.workflowId && filters.workflowId !== message.payload.workflowId) {
        return false;
      }

      // Tags would need to be in the message payload - for now, pass if workflow matches
      return true;
    });
  }

  /**
   * Send message to a specific client
   */
  send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(serializeServerMessage(message));
    }
  }

  /**
   * Get total subscriber count
   */
  getTotalSubscribers(): number {
    return this.subscriptions.size;
  }

  /**
   * Get subscriber count per channel
   */
  getChannelCounts(): Record<Channel, number> {
    return {
      workflows: this.channelSubscribers.get('workflows')?.size || 0,
      queue: this.channelSubscribers.get('queue')?.size || 0,
      agents: this.channelSubscribers.get('agents')?.size || 0,
    };
  }

  /**
   * Clear all subscriptions (for testing)
   */
  clear(): void {
    this.subscriptions.clear();
    this.channelSubscribers.get('workflows')?.clear();
    this.channelSubscribers.get('queue')?.clear();
    this.channelSubscribers.get('agents')?.clear();
  }
}

// Singleton instance
let subscriptionManager: SubscriptionManager | null = null;

/**
 * Get the subscription manager instance
 */
export function getSubscriptionManager(): SubscriptionManager {
  if (!subscriptionManager) {
    subscriptionManager = new SubscriptionManager();
  }
  return subscriptionManager;
}

/**
 * Reset subscription manager (for testing)
 */
export function resetSubscriptionManager(): void {
  subscriptionManager?.clear();
  subscriptionManager = null;
}
