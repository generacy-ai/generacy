import type http from 'node:http';
import type { ActorContext } from '../context.js';
import { readBody } from '../util/read-body.js';

export async function handleGetRole(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  const body = {
    id: params['id'] ?? 'unknown',
    description: 'Stub role',
    credentials: [],
  };

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify(body));
}

export async function handlePutRole(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  _params: Record<string, string>,
): Promise<void> {
  await readBody(req);

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true }));
}
