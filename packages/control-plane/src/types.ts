import type http from 'node:http';
import type { ActorContext } from './context.js';

export interface ServerConfig {
  socketPath: string;
}

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  params: Record<string, string>,
) => Promise<void>;
