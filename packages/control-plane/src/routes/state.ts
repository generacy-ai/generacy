import type http from 'node:http';
import type { ActorContext } from '../context.js';
import { getClusterState } from '../state.js';

export async function handleGetState(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  _params: Record<string, string>,
): Promise<void> {
  const state = getClusterState();

  const body: Record<string, unknown> = {
    status: state.status,
    deploymentMode: state.deploymentMode,
    variant: state.variant,
    lastSeen: state.lastSeen,
  };

  if (state.statusReason !== undefined) {
    body.statusReason = state.statusReason;
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify(body));
}
