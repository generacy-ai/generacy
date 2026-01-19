/**
 * Connection type definitions for Agency and Humancy connections.
 */

import type { MessageEnvelope, MessageHandler } from './messages.js';

/** Humancy connection type variants */
export type HumancyType = 'vscode' | 'cloud';

/** Connection status */
export type ConnectionStatus = 'online' | 'offline';

/** Base connection interface */
export interface BaseConnection {
  /** Unique connection identifier */
  readonly id: string;

  /** Send a message through this connection */
  send(message: MessageEnvelope): Promise<void>;

  /** Register message handler */
  onMessage(handler: MessageHandler): void;

  /** Register disconnect handler */
  onDisconnect(handler: () => void): void;

  /** Close the connection */
  close(): Promise<void>;
}

/** Agency connection interface */
export interface AgencyConnection extends BaseConnection {
  /** Connection type marker for type discrimination */
  readonly connectionType: 'agency';
}

/** Humancy connection interface */
export interface HumancyConnection extends BaseConnection {
  /** Connection type marker for type discrimination */
  readonly connectionType: 'humancy';

  /** Humancy interface type */
  readonly type: HumancyType;
}

/** Union type for any connection */
export type Connection = AgencyConnection | HumancyConnection;

/** Registered connection wrapper with metadata */
export interface RegisteredConnection<T extends BaseConnection> {
  /** The underlying connection */
  connection: T;

  /** Current connection status */
  status: ConnectionStatus;

  /** Registration timestamp (Unix ms) */
  registeredAt: number;

  /** Last activity timestamp (Unix ms) */
  lastSeenAt: number;
}

/** Type guard for AgencyConnection */
export function isAgencyConnection(conn: Connection): conn is AgencyConnection {
  return conn.connectionType === 'agency';
}

/** Type guard for HumancyConnection */
export function isHumancyConnection(conn: Connection): conn is HumancyConnection {
  return conn.connectionType === 'humancy';
}
