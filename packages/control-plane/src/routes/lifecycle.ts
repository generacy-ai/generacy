import type http from 'node:http';
import type { ActorContext } from '../context.js';
import { LifecycleActionSchema } from '../schemas.js';
import { ControlPlaneError } from '../errors.js';
import { getCodeServerManager } from '../services/code-server-manager.js';

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

  res.setHeader('Content-Type', 'application/json');

  if (parsed.data === 'code-server-start') {
    const manager = getCodeServerManager();
    let result;
    try {
      result = await manager.start();
    } catch (err) {
      throw new ControlPlaneError(
        'SERVICE_UNAVAILABLE',
        err instanceof Error ? err.message : 'Failed to start code-server',
      );
    }
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (parsed.data === 'code-server-stop') {
    const manager = getCodeServerManager();
    await manager.stop();
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: true, action: parsed.data }));
    return;
  }

  res.writeHead(200);
  res.end(JSON.stringify({ accepted: true, action: parsed.data }));
}
