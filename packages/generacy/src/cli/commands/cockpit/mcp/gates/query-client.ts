/**
 * Read-side HTTP client for the two remote-gate MCP query tools (#1038 T032).
 *
 * This file is SEPARATE from `./client.ts` by design — the observer-independence
 * static import-scan (FR-012 / research R12) asserts that the read tools do
 * NOT import from `./client.ts`, `./tools/cockpit_gate_open.ts`,
 * `./tools/cockpit_gate_ack.ts`, or any `retained-cockpit-events.ts` path. If
 * you find yourself wanting to share code between the two clients, extract a
 * neutral primitive into `./http-common.ts` instead of cross-importing.
 *
 * Single-call contract: no retry inside this client. Retry lives in the tool
 * handler via `withRetry`+`QUERY_RETRY_SCHEDULE` (plan D-2 / research R2).
 *
 * Error mapping (research R5):
 *   - 400 (Bad Request)                     → `QueryInvalidArgsError`
 *   - other 4xx (401/403/404/405/422/…)     → `QueryInternalError`
 *   - 5xx / network / DNS / timeout         → `QueryTransportError`
 *   - 2xx with non-JSON / missing envelope  → `QueryInternalError`
 */
import type {
  CockpitGateStatusInput,
  CockpitGateStatusData,
  CockpitGateListInput,
  CockpitGateListData,
} from './query-schemas.js';
import {
  CockpitGateStatusDataSchema,
  CockpitGateListDataSchema,
} from './query-schemas.js';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** 400 from orchestrator — caller passed a bad shape. Do NOT retry. */
export class QueryInvalidArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryInvalidArgsError';
  }
}

/** 5xx / network / DNS / timeout. Retryable by the tool boundary. */
export class QueryTransportError extends Error {
  readonly httpStatus?: number;
  constructor(message: string, details?: { httpStatus?: number }) {
    super(message);
    this.name = 'QueryTransportError';
    if (details?.httpStatus !== undefined) this.httpStatus = details.httpStatus;
  }
}

/** Orchestrator returned an unexpected shape — a build/deploy bug. Do NOT retry. */
export class QueryInternalError extends Error {
  readonly httpStatus?: number;
  constructor(message: string, details?: { httpStatus?: number }) {
    super(message);
    this.name = 'QueryInternalError';
    if (details?.httpStatus !== undefined) this.httpStatus = details.httpStatus;
  }
}

/**
 * Predicate for `withRetry.shouldRetry`. Returns `true` iff the failure was
 * a transient transport-class error (5xx / network). Deterministic bugs
 * (`QueryInvalidArgsError` / `QueryInternalError`) short-circuit the retry.
 */
export function isRetryableGateQueryError(err: unknown, _attempt: number): boolean {
  return err instanceof QueryTransportError;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface QueryClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface GateQueryClient {
  getGateStatus(input: CockpitGateStatusInput): Promise<CockpitGateStatusData>;
  listGates(input: CockpitGateListInput): Promise<CockpitGateListData>;
}

function buildStatusUrl(baseUrl: string, input: CockpitGateStatusInput): string {
  const url = new URL('/cockpit/gates', baseUrl);
  url.searchParams.set('issueRef', input.issueRef);
  url.searchParams.set('gateType', input.gateType);
  url.searchParams.set('generation', String(input.generation));
  return url.toString();
}

function buildListUrl(baseUrl: string, input: CockpitGateListInput): string {
  const url = new URL('/cockpit/gates', baseUrl);
  url.searchParams.set('issueRef', input.issueRef);
  if (input.gateType !== undefined) url.searchParams.set('gateType', input.gateType);
  return url.toString();
}

function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  return (err as { name?: unknown }).name === 'AbortError';
}

function firstLineOr(text: string, fallback: string): string {
  const t = text.trim();
  if (!t) return fallback;
  const first = t.split('\n')[0];
  return first != null && first.length > 0 ? first : fallback;
}

async function readTextSafe(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function fetchOnce(url: string, options: QueryClientOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await options.fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new QueryTransportError(
        `orchestrator request timed out after ${options.timeoutMs}ms`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new QueryTransportError(firstLineOr(msg, 'network error'));
  } finally {
    clearTimeout(timer);
  }
}

async function decodeResponse<T>(
  res: Response,
  schema: { parse: (raw: unknown) => T },
  verb: 'status' | 'list',
): Promise<T> {
  if (res.ok) {
    const text = await readTextSafe(res);
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      throw new QueryInternalError(
        `orchestrator returned non-JSON ${verb} response`,
      );
    }
    try {
      return schema.parse(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new QueryInternalError(
        `orchestrator returned malformed ${verb} envelope: ${firstLineOr(msg, 'shape mismatch')}`,
      );
    }
  }
  const bodyText = await readTextSafe(res);
  const detail = firstLineOr(bodyText, `HTTP ${res.status}`);
  if (res.status === 400) {
    throw new QueryInvalidArgsError(detail);
  }
  if (res.status >= 500 && res.status < 600) {
    throw new QueryTransportError(detail, { httpStatus: res.status });
  }
  // Other 4xx (401/403/404/405/422/429...) — orchestrator/route bug.
  throw new QueryInternalError(detail, { httpStatus: res.status });
}

export function createGateQueryClient(options: QueryClientOptions): GateQueryClient {
  return {
    async getGateStatus(input) {
      const url = buildStatusUrl(options.baseUrl, input);
      const res = await fetchOnce(url, options);
      return decodeResponse(res, CockpitGateStatusDataSchema, 'status');
    },
    async listGates(input) {
      const url = buildListUrl(options.baseUrl, input);
      const res = await fetchOnce(url, options);
      return decodeResponse(res, CockpitGateListDataSchema, 'list');
    },
  };
}
