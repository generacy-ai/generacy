import type http from 'node:http';

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
