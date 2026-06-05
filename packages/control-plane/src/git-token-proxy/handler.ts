import http from 'node:http';
import { isAllowedRoute, pickAllowedHeaders } from './allowlists.js';
import { mapUpstreamErrorToCode } from './upstream-errors.js';
import { logUpstreamError } from './logging.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const UPSTREAM_TIMEOUT_MS = 30_000;

export interface CreateHandlerOptions {
  upstreamSocketPath: string;
  httpRequest?: typeof http.request;
}

export type ProxyRequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export function createHandler(options: CreateHandlerOptions): ProxyRequestHandler {
  const { upstreamSocketPath } = options;
  const httpRequest = options.httpRequest ?? http.request;

  return function handle(req, res): void {
    if (!isAllowedRoute(req.method, req.url)) {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: 'request body exceeds 64 KiB',
            code: 'PAYLOAD_TOO_LARGE',
          }),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks);

      const outboundHeaders = pickAllowedHeaders(req.headers);
      outboundHeaders['content-length'] = String(body.length);

      const upstreamReq = httpRequest({
        socketPath: upstreamSocketPath,
        method: 'POST',
        path: '/git-token',
        headers: outboundHeaders,
      });

      let settled = false;
      const onFailure = (err: unknown): void => {
        if (settled) return;
        settled = true;
        const code = mapUpstreamErrorToCode(err);
        logUpstreamError({ code });
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              error: 'control-plane upstream unreachable',
              code,
            }),
          );
        } else {
          res.end();
        }
      };

      upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        upstreamReq.destroy(new Error('timeout'));
      });

      upstreamReq.on('response', (upstreamRes) => {
        if (settled) return;
        settled = true;
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => {
          if (!res.writableEnded) res.end();
        });
      });

      upstreamReq.on('error', onFailure);

      upstreamReq.write(body);
      upstreamReq.end();
    });

    req.on('error', () => {
      if (!res.headersSent) res.writeHead(400).end();
    });
  };
}
