import type http from 'node:http';

import type { ActorContext } from '../context.js';
import { ControlPlaneError } from '../errors.js';
import { readBody } from '../util/read-body.js';
import { AuditBatchSchema } from '../schemas.js';

export type PushEventFn = (channel: string, payload: unknown) => void;

let pushEventFn: PushEventFn | undefined;

/** Inject the relay pushEvent callback at server construction time. */
export function setRelayPushEvent(fn: PushEventFn): void {
  pushEventFn = fn;
}

/**
 * POST /internal/audit-batch
 * Receives an audit batch from credhelper-daemon, validates it,
 * and emits each entry on the relay's cluster.audit channel.
 */
export async function handlePostAuditBatch(
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

  const result = AuditBatchSchema.safeParse(parsed);
  if (!result.success) {
    throw new ControlPlaneError('INVALID_REQUEST', 'Invalid audit batch', {
      errors: result.error.issues.map((i) => i.message),
    });
  }

  const batch = result.data;

  // Emit each entry on the relay's cluster.audit channel
  if (pushEventFn) {
    for (const entry of batch.entries) {
      pushEventFn('cluster.audit', entry);
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
