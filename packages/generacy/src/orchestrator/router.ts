/**
 * HTTP router utility for the orchestrator server.
 * Provides simple path-matching routing without external dependencies.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Route match result containing the handler name and extracted parameters
 */
export interface RouteMatch {
  /** Handler name to invoke */
  handler: string;
  /** Extracted path parameters */
  params: Record<string, string>;
}

/**
 * Route definition with method, pattern, handler, and optional parameter names
 */
export interface Route {
  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  method: string;
  /** Regular expression pattern to match the path */
  pattern: RegExp;
  /** Handler name to invoke when matched */
  handler: string;
  /** Names of path parameters in order of capture groups */
  paramNames?: string[];
}

/**
 * Result of converting a path pattern to regex
 */
export interface PathToRegexResult {
  /** Regular expression for matching paths */
  regex: RegExp;
  /** Parameter names extracted from the pattern */
  paramNames: string[];
}

/**
 * Convert a path pattern like `/api/workers/:id` to a regex with parameter names.
 *
 * @param pattern - Path pattern with `:paramName` placeholders
 * @returns Object containing regex and parameter names
 *
 * @example
 * ```typescript
 * const result = pathToRegex('/api/workers/:id');
 * // result.regex = /^\/api\/workers\/([^/]+)$/
 * // result.paramNames = ['id']
 *
 * const result2 = pathToRegex('/api/jobs/:id/result');
 * // result2.regex = /^\/api\/jobs\/([^/]+)\/result$/
 * // result2.paramNames = ['id']
 * ```
 */
export function pathToRegex(pattern: string): PathToRegexResult {
  const paramNames: string[] = [];

  // Escape special regex characters except for colons (which mark params)
  // and forward slashes (which we keep as literal)
  const regexPattern = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, paramName) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });

  return {
    regex: new RegExp(`^${regexPattern}$`),
    paramNames,
  };
}

/**
 * Router function type returned by createRouter
 */
export type Router = (method: string, path: string) => RouteMatch | null;

/**
 * Create a router function from a list of routes.
 *
 * @param routes - Array of route definitions
 * @returns Function that matches a method and path to a route
 *
 * @example
 * ```typescript
 * const router = createRouter([
 *   { method: 'POST', pattern: /^\/api\/workers\/register$/, handler: 'registerWorker' },
 *   { method: 'DELETE', pattern: /^\/api\/workers\/([^/]+)$/, handler: 'unregisterWorker', paramNames: ['id'] },
 * ]);
 *
 * const match = router('DELETE', '/api/workers/abc123');
 * // match = { handler: 'unregisterWorker', params: { id: 'abc123' } }
 * ```
 */
export function createRouter(routes: Route[]): Router {
  return (method: string, path: string): RouteMatch | null => {
    for (const route of routes) {
      if (method !== route.method) continue;

      const match = path.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames?.forEach((name, i) => {
          const value = match[i + 1];
          if (value !== undefined) {
            params[name] = value;
          }
        });
        return { handler: route.handler, params };
      }
    }
    return null;
  };
}

/**
 * Parse JSON body from an incoming HTTP request.
 *
 * @param req - Incoming HTTP request
 * @returns Parsed JSON body
 * @throws Error if body is not valid JSON
 *
 * @example
 * ```typescript
 * interface RegisterRequest {
 *   name: string;
 *   capabilities: string[];
 * }
 *
 * const body = await parseJsonBody<RegisterRequest>(req);
 * console.log(body.name, body.capabilities);
 * ```
 */
export async function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer | string) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        if (!body) {
          resolve({} as T);
          return;
        }
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 *
 * @param res - Server response object
 * @param status - HTTP status code
 * @param data - Data to serialize as JSON
 *
 * @example
 * ```typescript
 * sendJson(res, 200, { workerId: 'abc123' });
 * sendJson(res, 201, { job: { id: 'job-1', status: 'pending' } });
 * ```
 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send an error response in the standard orchestrator error format.
 *
 * @param res - Server response object
 * @param status - HTTP status code
 * @param code - Error code (e.g., 'WORKER_NOT_FOUND')
 * @param message - Human-readable error message
 *
 * @example
 * ```typescript
 * sendError(res, 404, 'WORKER_NOT_FOUND', 'Worker with ID abc123 not found');
 * sendError(res, 400, 'INVALID_REQUEST', 'Missing required field: name');
 * ```
 */
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(res, status, { error: { code, message } });
}
