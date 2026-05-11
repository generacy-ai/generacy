import type http from 'node:http';
import type { ActorContext } from './context.js';
import type { RouteHandler } from './types.js';
import { ControlPlaneError } from './errors.js';
import { handleGetState } from './routes/state.js';
import { handleGetCredential, handlePutCredential } from './routes/credentials.js';
import { handlePostLifecycle } from './routes/lifecycle.js';
import { handlePostAuditBatch } from './routes/audit.js';
import { handlePostStatus } from './routes/status.js';

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/state$/,
    paramNames: [],
    handler: handleGetState,
  },
  {
    method: 'GET',
    pattern: /^\/credentials\/([^/]+)$/,
    paramNames: ['id'],
    handler: handleGetCredential,
  },
  {
    method: 'PUT',
    pattern: /^\/credentials\/([^/]+)$/,
    paramNames: ['id'],
    handler: handlePutCredential,
  },
  {
    method: 'POST',
    pattern: /^\/lifecycle\/([^/]+)$/,
    paramNames: ['action'],
    handler: handlePostLifecycle,
  },
  {
    method: 'POST',
    pattern: /^\/internal\/audit-batch$/,
    paramNames: [],
    handler: handlePostAuditBatch,
  },
  {
    method: 'POST',
    pattern: /^\/internal\/status$/,
    paramNames: [],
    handler: handlePostStatus,
  },
];

export async function dispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  // Check for URL match first (ignoring method) to distinguish 404 from 405
  let urlMatched = false;

  for (const route of routes) {
    const match = url.match(route.pattern);
    if (match) {
      urlMatched = true;
      if (route.method === method) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          const name = route.paramNames[i]!;
          params[name] = match[i + 1]!;
        }
        await route.handler(req, res, actor, params);
        return;
      }
    }
  }

  if (urlMatched) {
    throw new ControlPlaneError('INVALID_REQUEST', `Method not allowed: ${method} ${url}`);
  }

  throw new ControlPlaneError('NOT_FOUND', `Not found: ${method} ${url}`);
}
