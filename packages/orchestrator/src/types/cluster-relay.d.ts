/**
 * Type declarations for @generacy-ai/cluster-relay (Phase 2.1).
 *
 * This package is not yet implemented. These declarations allow the orchestrator
 * to compile with the dynamic import in server.ts. Once Phase 2.1 is complete,
 * this file should be replaced by the package's own type exports.
 */

declare module '@generacy-ai/cluster-relay' {
  import type {
    ClusterRelayClient as IClusterRelayClient,
    ClusterRelayClientOptions,
  } from './relay.js';

  export class ClusterRelayClient implements IClusterRelayClient {
    constructor(options: ClusterRelayClientOptions);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(message: import('./relay.js').RelayMessage): void;
    on(event: 'message', handler: (msg: import('./relay.js').RelayMessage) => void): void;
    on(event: 'connected', handler: () => void): void;
    on(event: 'disconnected', handler: (reason: string) => void): void;
    on(event: 'error', handler: (error: Error) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
    readonly isConnected: boolean;
  }
}
