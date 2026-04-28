import type http from 'node:http';
import type { ActorContext } from '../context.js';
import { LifecycleActionSchema } from '../schemas.js';
import { ControlPlaneError } from '../errors.js';

export async function handlePostLifecycle(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  const action = params['action'] ?? '';
  const parsed = LifecycleActionSchema.safeParse(action);

  if (!parsed.success) {
    throw new ControlPlaneError('UNKNOWN_ACTION', `Unknown lifecycle action: ${action}`);
  }

  const body = {
    accepted: true as const,
    action: parsed.data,
  };

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify(body));
}
