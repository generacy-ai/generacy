import http from 'node:http';
import https from 'node:https';
import {
  DeviceCodeResponseSchema,
  type DeviceCodeResponse,
  type HttpClient,
  type HttpResponse,
  type PollResponse,
  type ActivationLogger,
} from './types.js';
import { PollResponseSchema } from './types.js';
import { ActivationError } from './errors.js';

const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;
const JITTER_FACTOR = 0.1;

/**
 * Native Node.js HTTP client implementation.
 */
export class NativeHttpClient implements HttpClient {
  async post<T>(url: string, body?: unknown): Promise<HttpResponse<T>> {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const payload = body != null ? JSON.stringify(body) : undefined;

    return new Promise<HttpResponse<T>>((resolve, reject) => {
      const req = transport.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(payload != null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            try {
              const data = JSON.parse(raw) as T;
              resolve({ status: res.statusCode ?? 0, data });
            } catch {
              reject(new Error(`Invalid JSON response from ${url}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.setTimeout(30_000, () => {
        req.destroy(new Error(`Request timeout: ${url}`));
      });

      if (payload != null) {
        req.write(payload);
      }
      req.end();
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoff(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = delay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return delay + jitter;
}

/**
 * Request a device code from the cloud, with retries.
 */
export async function initDeviceFlow(
  cloudUrl: string,
  httpClient: HttpClient,
  logger: ActivationLogger,
  maxRetries = DEFAULT_MAX_RETRIES,
): Promise<DeviceCodeResponse> {
  const url = `${cloudUrl}/api/clusters/device-code`;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = computeBackoff(attempt - 1);
      logger.warn(`Cloud unreachable, retrying (${attempt}/${maxRetries}) in ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }

    try {
      const response = await httpClient.post<unknown>(url);
      const parsed = DeviceCodeResponseSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new ActivationError(
          `Invalid device-code response: ${parsed.error.message}`,
          'INVALID_RESPONSE',
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ActivationError && error.code === 'INVALID_RESPONSE') {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new ActivationError(
    `Cloud unreachable after ${maxRetries + 1} attempts: ${lastError?.message}`,
    'CLOUD_UNREACHABLE',
  );
}

/**
 * Single-shot poll request (no retry).
 */
export async function pollDeviceCode(
  cloudUrl: string,
  deviceCode: string,
  httpClient: HttpClient,
): Promise<PollResponse> {
  const url = `${cloudUrl}/api/clusters/device-code/poll`;
  const response = await httpClient.post<unknown>(url, { device_code: deviceCode });
  const parsed = PollResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new ActivationError(
      `Invalid poll response: ${parsed.error.message}`,
      'INVALID_RESPONSE',
    );
  }
  return parsed.data;
}
