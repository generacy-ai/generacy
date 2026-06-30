import { NativeHttpClient, type HttpClient } from './http.js';
import { createStubOrchestratorClient } from './stub.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3100';

export interface JobSummary {
  id: string;
  status: string;
  workflowId?: string;
}

export type UnavailableReason = 'no-token' | 'cloud-unreachable' | 'http-error' | 'timeout';

export type HealthResult =
  | { available: false; reason: UnavailableReason; statusCode?: number }
  | { available: true; status: 'ok' | 'degraded'; data: Record<string, unknown> };

export type JobsResult =
  | { available: false; reason: UnavailableReason; statusCode?: number }
  | { available: true; jobs: JobSummary[] };

export type WorkersResult =
  | { available: false; reason: UnavailableReason; statusCode?: number }
  | { available: true; count: number };

export interface OrchestratorClient {
  isAvailable(): boolean;
  health(): Promise<HealthResult>;
  getJobs(): Promise<JobsResult>;
  getWorkers(): Promise<WorkersResult>;
}

export interface CreateOrchestratorClientConfig {
  baseUrl?: string;
  token?: string;
  httpClient?: HttpClient;
}

function trimToken(token: string | undefined): string | undefined {
  if (token == null) return undefined;
  const t = token.trim();
  return t.length > 0 ? t : undefined;
}

function normalizeJobs(raw: unknown): JobSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): JobSummary[] => {
    if (item == null || typeof item !== 'object') return [];
    const obj = item as Record<string, unknown>;
    const id = obj['id'];
    const status = obj['status'];
    if (typeof id !== 'string' || typeof status !== 'string') return [];
    const workflowId = typeof obj['workflowId'] === 'string' ? (obj['workflowId'] as string) : undefined;
    return [{ id, status, ...(workflowId != null ? { workflowId } : {}) }];
  });
}

function pickArrayField(data: unknown, ...keys: string[]): unknown {
  if (Array.isArray(data)) return data;
  if (data == null || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return [];
}

function createLiveClient(
  baseUrl: string,
  token: string,
  httpClient: HttpClient,
): OrchestratorClient {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  async function call<T>(path: string): Promise<{ ok: true; status: number; data: T } | { ok: false; status?: number; reason: 'cloud-unreachable' | 'http-error' }> {
    const url = `${baseUrl}${path}`;
    try {
      const response = await httpClient.get<T>(url, { headers });
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, status: response.status, reason: 'http-error' };
      }
      return { ok: true, status: response.status, data: response.data };
    } catch {
      return { ok: false, reason: 'cloud-unreachable' };
    }
  }

  return {
    isAvailable(): boolean {
      return true;
    },
    async health(): Promise<HealthResult> {
      const result = await call<unknown>('/health');
      if (!result.ok) {
        return result.status != null
          ? { available: false, reason: result.reason, statusCode: result.status }
          : { available: false, reason: result.reason };
      }
      const body = result.data;
      const status =
        body != null &&
        typeof body === 'object' &&
        (body as Record<string, unknown>)['status'] === 'degraded'
          ? 'degraded'
          : 'ok';
      const data: Record<string, unknown> =
        body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      return { available: true, status, data };
    },
    async getJobs(): Promise<JobsResult> {
      const result = await call<unknown>('/queue');
      if (!result.ok) {
        return result.status != null
          ? { available: false, reason: result.reason, statusCode: result.status }
          : { available: false, reason: result.reason };
      }
      const jobs = normalizeJobs(pickArrayField(result.data, 'jobs', 'queue', 'items'));
      return { available: true, jobs };
    },
    async getWorkers(): Promise<WorkersResult> {
      const result = await call<unknown>('/dispatch/queue/workers');
      if (!result.ok) {
        return result.status != null
          ? { available: false, reason: result.reason, statusCode: result.status }
          : { available: false, reason: result.reason };
      }
      const data = result.data;
      const count =
        data != null &&
        typeof data === 'object' &&
        typeof (data as Record<string, unknown>)['count'] === 'number'
          ? ((data as Record<string, unknown>)['count'] as number)
          : 0;
      return { available: true, count };
    },
  };
}

/**
 * Factory that dispatches between the stub and live client.
 *
 * - If `config.token` is `undefined`, empty, or whitespace-only ⇒ returns the
 *   stub. Every method resolves to `{ available: false, reason: 'no-token' }`.
 * - Otherwise ⇒ returns the live client wired to `httpClient` (default:
 *   `NativeHttpClient`). The live client never throws — HTTP errors map to
 *   `{ reason: 'http-error', statusCode }`, network errors map to
 *   `{ reason: 'cloud-unreachable' }`.
 *
 * The factory itself never throws.
 */
export function createOrchestratorClient(
  config: CreateOrchestratorClientConfig = {},
): OrchestratorClient {
  const token = trimToken(config.token);
  if (token == null) return createStubOrchestratorClient();
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const httpClient = config.httpClient ?? new NativeHttpClient();
  return createLiveClient(baseUrl, token, httpClient);
}
