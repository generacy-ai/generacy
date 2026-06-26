import http from 'node:http';
import https from 'node:https';

export interface HttpResponse<T> {
  status: number;
  data: T;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpClient {
  get<T>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Native Node.js HTTP client for GET requests.
 * Mirrors `packages/activation-client/src/client.ts` shape.
 *
 * Rejects with an Error on:
 *   - Network failure (ECONNREFUSED, ENOTFOUND, etc.)
 *   - Timeout
 *   - Malformed JSON response
 *
 * Non-2xx HTTP responses are returned as `{ status, data }` so the caller can
 * map them into result envelopes.
 */
export class NativeHttpClient implements HttpClient {
  async get<T>(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<HttpResponse<T>>((resolve, reject) => {
      const req = transport.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...(options.headers ?? {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            const status = res.statusCode ?? 0;
            if (raw.length === 0) {
              resolve({ status, data: undefined as unknown as T });
              return;
            }
            try {
              const data = JSON.parse(raw) as T;
              resolve({ status, data });
            } catch {
              reject(new Error(`Invalid JSON response from ${url}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request timeout: ${url}`));
      });
      req.end();
    });
  }
}
