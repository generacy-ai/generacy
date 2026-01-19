/**
 * Public type exports for the message router.
 */

// Message types
export type {
  MessageType,
  EndpointType,
  MessageEndpoint,
  MessageMeta,
  MessageEnvelope,
  MessageHandler,
} from './messages.js';

export {
  DEFAULT_TTL,
  createMessageEnvelope,
  isMessageExpired,
} from './messages.js';

// Connection types
export type {
  HumancyType,
  ConnectionStatus,
  BaseConnection,
  AgencyConnection,
  HumancyConnection,
  Connection,
  RegisteredConnection,
} from './connections.js';

export {
  isAgencyConnection,
  isHumancyConnection,
} from './connections.js';

// Channel types
export type {
  ChannelContext,
  ChannelHandler,
  Channel,
} from './channels.js';

export {
  RESERVED_CHANNEL_NAMES,
  CHANNEL_NAME_PATTERN,
  isValidChannelName,
  InvalidChannelNameError,
  ChannelExistsError,
  ChannelNotFoundError,
} from './channels.js';

// Config types
export type {
  RedisConfig,
  RetryConfig,
  RouterConfig,
} from './config.js';

export {
  DEFAULT_RETRY_CONFIG,
  DEFAULT_REDIS_CONFIG,
  createRouterConfig,
} from './config.js';
