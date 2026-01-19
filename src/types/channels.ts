/**
 * Channel system types for plugin-defined message routing.
 */

import type { MessageEnvelope } from './messages.js';

/** Context provided to channel handlers */
export interface ChannelContext {
  /** Send response back to source */
  reply(payload: unknown): Promise<void>;

  /** Forward message to another channel */
  forward(channel: string, payload: unknown): Promise<void>;

  /** Original message being handled */
  readonly message: MessageEnvelope;
}

/** Handler function for channel messages */
export type ChannelHandler = (
  message: MessageEnvelope,
  context: ChannelContext
) => void | Promise<void>;

/** Channel registration entry */
export interface Channel {
  /** Channel name (unique identifier) */
  name: string;

  /** Handler for messages on this channel */
  handler: ChannelHandler;

  /** ID of the plugin that registered this channel */
  registeredBy: string;

  /** Registration timestamp (Unix ms) */
  registeredAt: number;
}

/** Reserved channel names that cannot be used */
export const RESERVED_CHANNEL_NAMES = ['system', 'internal', 'router'] as const;

/** Channel name validation pattern: alphanumeric + underscore, 1-64 chars */
export const CHANNEL_NAME_PATTERN = /^[a-zA-Z0-9_]{1,64}$/;

/** Validates a channel name */
export function isValidChannelName(name: string): boolean {
  if (!CHANNEL_NAME_PATTERN.test(name)) {
    return false;
  }
  return !RESERVED_CHANNEL_NAMES.includes(name as typeof RESERVED_CHANNEL_NAMES[number]);
}

/** Error thrown when channel name is invalid */
export class InvalidChannelNameError extends Error {
  constructor(name: string, reason: string) {
    super(`Invalid channel name "${name}": ${reason}`);
    this.name = 'InvalidChannelNameError';
  }
}

/** Error thrown when channel already exists */
export class ChannelExistsError extends Error {
  constructor(name: string) {
    super(`Channel "${name}" is already registered`);
    this.name = 'ChannelExistsError';
  }
}

/** Error thrown when channel is not found */
export class ChannelNotFoundError extends Error {
  constructor(name: string) {
    super(`Channel "${name}" not found`);
    this.name = 'ChannelNotFoundError';
  }
}
