import type http from 'node:http';
import type { ActorContext } from './context.js';
import type { ClusterState, ClusterStatus } from './schemas.js';

export interface ServerConfig {
  socketPath: string;
}

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  params: Record<string, string>,
) => Promise<void>;

export interface ClusterStateStore {
  getState(): ClusterState;
  updateStatus(status: ClusterStatus, statusReason?: string): void;
}
