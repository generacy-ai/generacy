import { request as httpRequest } from 'node:http';
import type { ApiRequestMessage, ApiResponseMessage } from './messages.js';
import type { RelayConfig } from './config.js';
import { resolveRoute, isUnixSocket, parseUnixTarget } from './dispatcher.js';

/**
 * Build the outgoing headers, including actor propagation.
 */
function buildHeaders(
  request: ApiRequestMessage,
  config: RelayConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...request.headers,
  };

  if (config.orchestratorApiKey) {
    headers['X-API-Key'] = config.orchestratorApiKey;
  }

  if (request.actor) {
    headers['x-generacy-actor-user-id'] = request.actor.userId;
    if (request.actor.sessionId) {
      headers['x-generacy-actor-session-id'] = request.actor.sessionId;
    }
  }

  return headers;
}

/**
 * Forward a request over a Unix domain socket using node:http.
 */
function forwardToUnixSocket(
  socketPath: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString();
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders[key] = value;
            } else if (Array.isArray(value)) {
              responseHeaders[key] = value.join(', ');
            }
          }

          let parsedBody: unknown;
          const contentType = res.headers['content-type'];
          if (contentType?.includes('application/json')) {
            try {
              parsedBody = JSON.parse(rawBody);
            } catch {
              parsedBody = rawBody;
            }
          } else {
            parsedBody = rawBody;
          }

          resolve({
            status: res.statusCode ?? 502,
            headers: responseHeaders,
            body: parsedBody,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new DOMException('The operation was aborted', 'TimeoutError'));
    });

    req.on('error', (err) => reject(err));

    if (body != null) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Forward a request using fetch to an HTTP target.
 */
async function forwardToHttp(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  let parsedBody: unknown;
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    parsedBody = await response.json();
  } else {
    parsedBody = await response.text();
  }

  return {
    status: response.status,
    headers: responseHeaders,
    body: parsedBody,
  };
}

/**
 * Handle an API request from the cloud by proxying it to the appropriate target.
 * Uses the path-prefix dispatcher to route to matched targets, falling back to orchestratorUrl.
 */
export async function handleApiRequest(
  request: ApiRequestMessage,
  config: RelayConfig,
): Promise<ApiResponseMessage> {
  const headers = buildHeaders(request, config);
  const body = request.body != null ? JSON.stringify(request.body) : undefined;

  try {
    const match = resolveRoute(request.path, config.routes);

    let result: { status: number; headers: Record<string, string>; body: unknown };

    if (match && isUnixSocket(match.route.target)) {
      const socketPath = parseUnixTarget(match.route.target);
      result = await forwardToUnixSocket(
        socketPath,
        request.method,
        match.strippedPath,
        headers,
        body,
        config.requestTimeoutMs,
      );
    } else if (match) {
      const url = `${match.route.target}${match.strippedPath}`;
      result = await forwardToHttp(url, request.method, headers, body, config.requestTimeoutMs);
    } else {
      const url = `${config.orchestratorUrl}${request.path}`;
      result = await forwardToHttp(url, request.method, headers, body, config.requestTimeoutMs);
    }

    return {
      type: 'api_response',
      correlationId: request.correlationId,
      status: result.status,
      headers: result.headers,
      body: result.body,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return {
        type: 'api_response',
        correlationId: request.correlationId,
        status: 504,
        body: { error: 'Gateway Timeout', message: 'Request to orchestrator timed out' },
      };
    }

    return {
      type: 'api_response',
      correlationId: request.correlationId,
      status: 502,
      body: { error: 'Bad Gateway', message: `Failed to reach orchestrator: ${String(error)}` },
    };
  }
}
