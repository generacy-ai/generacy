import http from 'node:http';
import { URL } from 'node:url';

import { DockerAllowlistMatcher } from './docker-allowlist.js';
import { ContainerNameResolver } from './docker-name-resolver.js';
import { validateBindMounts, bufferRequestBody } from './docker-bind-mount-guard.js';
import type { DockerRule } from './types.js';

/** Known-dangerous Docker API operations when forwarding to a host socket. */
const DANGEROUS_PATTERNS = [
  'POST /containers/create',
  'POST /exec',
  'POST /build',
];

/** Strip Docker API version prefix (e.g. /v1.41/containers/json → /containers/json). */
function normalizePath(rawPath: string): string {
  return rawPath.replace(/^\/v\d+\.\d+/, '');
}

/** Check if this is a `GET /containers/{id}/logs?follow=true` request. */
function isFollowLogsRequest(method: string, normalizedPath: string, rawUrl: string): boolean {
  if (method !== 'GET') return false;
  if (!/^\/containers\/[^/]+\/logs/.test(normalizedPath)) return false;
  try {
    const url = new URL(rawUrl, 'http://localhost');
    const follow = url.searchParams.get('follow');
    return follow === 'true' || follow === '1';
  } catch {
    // Fail closed: if we can't parse the URL, deny follow
    return true;
  }
}

function sendDeny(
  res: http.ServerResponse,
  method: string,
  path: string,
  reason: string,
  extra?: Record<string, unknown>,
): void {
  const body = JSON.stringify({
    error: `Docker API access denied: ${method} ${path}`,
    code: 'DOCKER_ACCESS_DENIED',
    details: {
      method,
      path,
      ...extra,
      reason,
    },
  });
  res.writeHead(403, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export interface DockerProxyHandlerOptions {
  rules: DockerRule[];
  upstreamSocket: string;
  upstreamIsHost: boolean;
  nameResolver: ContainerNameResolver;
  /** Per-session scratch dir for bind-mount validation (host-socket mode only) */
  scratchDir?: string;
}

/**
 * Create an HTTP request listener that proxies allowed Docker API requests
 * to the upstream socket and denies everything else with HTTP 403.
 */
export function createDockerProxyHandler(
  options: DockerProxyHandlerOptions,
): http.RequestListener {
  const { upstreamSocket, upstreamIsHost, nameResolver, scratchDir } = options;
  const matcher = new DockerAllowlistMatcher(options.rules);

  return (clientReq: http.IncomingMessage, clientRes: http.ServerResponse) => {
    void handleRequest(clientReq, clientRes, matcher, nameResolver, upstreamSocket, upstreamIsHost, scratchDir);
  };
}

async function handleRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  matcher: DockerAllowlistMatcher,
  nameResolver: ContainerNameResolver,
  upstreamSocket: string,
  upstreamIsHost: boolean,
  scratchDir?: string,
): Promise<void> {
  const method = (clientReq.method ?? 'GET').toUpperCase();
  const rawUrl = clientReq.url ?? '/';

  // Strip version prefix for matching
  const normalizedPath = normalizePath(rawUrl.split('?')[0] ?? rawUrl);

  // Reject follow=true on logs endpoint
  if (isFollowLogsRequest(method, normalizedPath, rawUrl)) {
    sendDeny(clientRes, method, normalizedPath, 'Streaming follow is not permitted');
    return;
  }

  // Match against allowlist
  const result = matcher.match(method, normalizedPath);

  if (!result.allowed) {
    sendDeny(clientRes, method, normalizedPath, result.reason);
    return;
  }

  // If the rule needs name checking, resolve the container name
  if (result.needsNameCheck && result.containerId) {
    const containerName = await nameResolver.resolve(result.containerId);
    const nameResult = matcher.matchWithName(method, normalizedPath, containerName);

    if (!nameResult.allowed) {
      sendDeny(clientRes, method, normalizedPath, nameResult.reason, {
        containerId: result.containerId,
        containerName,
      });
      return;
    }
  }

  // Log security warning for dangerous paths on host socket
  if (upstreamIsHost) {
    const key = `${method} ${normalizedPath}`;
    if (DANGEROUS_PATTERNS.some((d) => key.startsWith(d))) {
      console.warn(`[credhelper] SECURITY: forwarding ${key} to host Docker socket`);
    }
  }

  // Bind-mount guard: buffer POST /containers/create on host-socket and validate
  if (upstreamIsHost && scratchDir && method === 'POST' && normalizedPath === '/containers/create') {
    let bodyStr: string;
    try {
      bodyStr = await bufferRequestBody(clientReq);
    } catch (err) {
      sendDeny(clientRes, method, normalizedPath, (err as Error).message);
      return;
    }

    try {
      const body = JSON.parse(bodyStr);
      const validation = validateBindMounts(body, scratchDir);
      if (!validation.valid) {
        const rejectedPaths = validation.violations.map((v) => v.source);
        sendDeny(clientRes, method, normalizedPath, 'Bind mount outside scratch directory', {
          rejectedPaths,
          scratchDir,
        });
        return;
      }
    } catch {
      // If body isn't valid JSON, let Docker handle the error
    }

    // Forward the buffered body
    forwardBufferedToUpstream(bodyStr, clientReq, clientRes, upstreamSocket, method, rawUrl);
    return;
  }

  // Forward the request to upstream
  forwardToUpstream(clientReq, clientRes, upstreamSocket, method, rawUrl);
}

function forwardBufferedToUpstream(
  body: string,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  upstreamSocket: string,
  method: string,
  rawUrl: string,
): void {
  const headers = { ...clientReq.headers };
  headers['content-length'] = String(Buffer.byteLength(body));

  const upstreamReq = http.request(
    {
      socketPath: upstreamSocket,
      method,
      path: rawUrl,
      headers,
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    },
  );

  upstreamReq.on('error', (err) => {
    if (!clientRes.headersSent) {
      const errBody = JSON.stringify({
        error: `Docker upstream error: ${err.message}`,
        code: 'DOCKER_ACCESS_DENIED',
      });
      clientRes.writeHead(502, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errBody),
      });
      clientRes.end(errBody);
    }
  });

  upstreamReq.end(body);
}

function forwardToUpstream(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  upstreamSocket: string,
  method: string,
  rawUrl: string,
): void {
  const upstreamReq = http.request(
    {
      socketPath: upstreamSocket,
      method,
      path: rawUrl,
      headers: clientReq.headers,
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    },
  );

  upstreamReq.on('error', (err) => {
    if (!clientRes.headersSent) {
      const body = JSON.stringify({
        error: `Docker upstream error: ${err.message}`,
        code: 'DOCKER_ACCESS_DENIED',
      });
      clientRes.writeHead(502, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      clientRes.end(body);
    }
  });

  clientReq.pipe(upstreamReq);
}
