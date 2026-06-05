import type http from 'node:http';

/**
 * Single-route privilege boundary. Returns true iff this method+path pair is
 * allowed through to upstream. The only true case is POST /git-token (with
 * optional query string). Trailing slash is significant; the query string is
 * stripped before comparison.
 */
export function isAllowedRoute(method: string | undefined, url: string | undefined): boolean {
  if (method !== 'POST') return false;
  if (typeof url !== 'string') return false;
  const queryIdx = url.indexOf('?');
  const path = queryIdx === -1 ? url : url.slice(0, queryIdx);
  return path === '/git-token';
}

/**
 * Returns a new headers object containing ONLY 'content-type' and
 * 'content-length' (when present in the input). All other keys are dropped.
 * Header names are normalized to lowercase. The caller is expected to
 * overwrite 'content-length' with the actual buffered body length before
 * forwarding upstream.
 */
export function pickAllowedHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (key !== 'content-type' && key !== 'content-length') continue;
    if (rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (typeof value !== 'string') continue;
    out[key] = value;
  }
  return out;
}
