import type http from 'node:http';
import type { ActorContext } from '../context.js';

export async function handleGetState(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  _params: Record<string, string>,
): Promise<void> {
  const body = {
    status: 'ready',
    deploymentMode: 'local',
    variant: 'cluster-base',
    lastSeen: new Date().toISOString(),
  };

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify(body));
}
