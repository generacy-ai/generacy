import type { RouteEntry } from './config.js';

export interface RouteMatch {
  route: RouteEntry;
  strippedPath: string;
}

/**
 * Sort routes by prefix length descending (longest first) for longest-prefix-match.
 */
export function sortRoutes(routes: RouteEntry[]): RouteEntry[] {
  return [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * Resolve a request path against pre-sorted routes using longest-prefix-match.
 * Returns the matched route and the path with the prefix stripped, or null.
 */
export function resolveRoute(path: string, routes: RouteEntry[]): RouteMatch | null {
  for (const route of routes) {
    if (path.startsWith(route.prefix)) {
      const stripped = path.slice(route.prefix.length);
      const strippedPath = stripped.startsWith('/') ? stripped : `/${stripped}`;
      return { route, strippedPath };
    }
  }
  return null;
}

/**
 * Check if a target string is a Unix socket URI.
 */
export function isUnixSocket(target: string): boolean {
  return target.startsWith('unix://');
}

/**
 * Extract the socket path from a unix:// target URI.
 */
export function parseUnixTarget(target: string): string {
  return target.slice('unix://'.length);
}
