import type http from 'node:http';
import type { ActorContext } from '../context.js';
import { ControlPlaneError } from '../errors.js';
import { readBody } from '../util/read-body.js';
import { StatusUpdateSchema } from '../schemas.js';
import { updateClusterStatus } from '../state.js';

export async function handlePostStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  _params: Record<string, string>,
): Promise<void> {
  const raw = await readBody(req);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ControlPlaneError('INVALID_REQUEST', 'Invalid JSON body');
  }

  const result = StatusUpdateSchema.safeParse(parsed);
  if (!result.success) {
    throw new ControlPlaneError('INVALID_REQUEST', 'Invalid status update', {
      errors: result.error.issues.map((i) => i.message),
    });
  }

  try {
    updateClusterStatus(result.data.status, result.data.statusReason);
  } catch (err) {
    throw new ControlPlaneError(
      'INVALID_REQUEST',
      err instanceof Error ? err.message : 'Invalid state transition',
    );
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
