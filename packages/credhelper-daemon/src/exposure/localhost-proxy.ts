import http from 'node:http';
import https from 'node:https';

import { CredhelperError } from '../errors.js';
import type { LocalhostProxyHandle } from '../types.js';
import type { ProxyRule } from '@generacy-ai/credhelper';

export interface LocalhostProxyConfig {
  port: number;
  upstream: string;
  headers: Record<string, string>;
  allowlist: ProxyRule[];
}

/**
 * Match a request method+path against an allowlist of rules.
 *
 * Path matching:
 * - Split pattern and request path by '/'
 * - Segment count must match exactly (trailing slash = significant)
 * - Each segment: literal match (case-sensitive) or {param} matches any non-empty string
 * - Query string stripped from request path before matching
 * - Method: exact match, case-insensitive (compared uppercase)
 */
export function matchAllowlist(
  method: string,
  requestPath: string,
  rules: ProxyRule[],
): boolean {
  // Strip query string
  const qIdx = requestPath.indexOf('?');
  const cleanPath = qIdx >= 0 ? requestPath.slice(0, qIdx) : requestPath;
  const upperMethod = method.toUpperCase();

  for (const rule of rules) {
    if (rule.method.toUpperCase() !== upperMethod) continue;

    const patternSegments = rule.path.split('/');
    const requestSegments = cleanPath.split('/');

    if (patternSegments.length !== requestSegments.length) continue;

    let match = true;
    for (let i = 0; i < patternSegments.length; i++) {
      const ps = patternSegments[i]!;
      const rs = requestSegments[i]!;

      if (ps.startsWith('{') && ps.endsWith('}')) {
        // {param} placeholder — matches any non-empty string
        if (rs.length === 0) {
          match = false;
          break;
        }
      } else {
        // Literal match, case-sensitive
        if (ps !== rs) {
          match = false;
          break;
        }
      }
    }

    if (match) return true;
  }

  return false;
}

/**
 * HTTP reverse proxy on 127.0.0.1:<port> with method+path allowlist.
 * Injects auth headers from plugin renderExposure output.
 * Returns 403 JSON for denied requests.
 * Follows DockerProxy lifecycle pattern (start/stop).
 */
export class LocalhostProxy implements LocalhostProxyHandle {
  private server: http.Server | null = null;

  constructor(private readonly config: LocalhostProxyConfig) {}

  async start(): Promise<void> {
    const { port, upstream, headers, allowlist } = this.config;

    this.server = http.createServer((req, res) => {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';

      if (!matchAllowlist(method, url, allowlist)) {
        // Strip query string for the details
        const qIdx = url.indexOf('?');
        const cleanPath = qIdx >= 0 ? url.slice(0, qIdx) : url;

        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `Request ${method} ${cleanPath} is not allowed by the proxy allowlist`,
            code: 'PROXY_ACCESS_DENIED',
            details: { method, path: cleanPath },
          }),
        );
        return;
      }

      // Forward to upstream
      const upstreamUrl = new URL(url, upstream);
      const isHttps = upstreamUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const proxyReq = transport.request(
        {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (isHttps ? 443 : 80),
          path: upstreamUrl.pathname + upstreamUrl.search,
          method,
          headers: {
            ...req.headers,
            host: upstreamUrl.host,
            ...headers,
          },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );

      proxyReq.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `Upstream error: ${err.message}`,
              code: 'INTERNAL_ERROR',
            }),
          );
        }
      });

      req.pipe(proxyReq);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(
            new CredhelperError(
              'PROXY_PORT_COLLISION',
              `Port ${port} is already in use`,
              { port },
            ),
          );
        } else {
          reject(err);
        }
      });
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }
}
