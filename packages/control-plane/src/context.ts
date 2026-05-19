import type http from 'node:http';
import { ControlPlaneError } from './errors.js';

export interface ActorContext {
  userId?: string;
  sessionId?: string;
}

function getHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return undefined;
}

export function extractActorContext(req: http.IncomingMessage): ActorContext {
  return {
    userId: getHeader(req, 'x-generacy-actor-user-id'),
    sessionId: getHeader(req, 'x-generacy-actor-session-id'),
  };
}

export function requireActor(actor: ActorContext): void {
  if (!actor.userId) {
    throw new ControlPlaneError('UNAUTHORIZED', 'Missing actor identity');
  }
}
