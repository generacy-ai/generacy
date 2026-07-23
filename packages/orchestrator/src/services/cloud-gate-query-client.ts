/**
 * Cluster → cloud query client for `cockpit_gate_status` and
 * `cockpit_gate_list` (#1038 R1). Backing store for the orchestrator's
 * `GET /cockpit/gates` route.
 *
 * Design mirrors `packages/control-plane/src/services/cloud-pull-client.ts`
 * (#766) and `packages/activation-client/src/client.ts` (#500):
 *   - HTTPS to `${GENERACY_API_URL}/api/clusters/:clusterId/cockpit/gates`.
 *   - `Authorization: Bearer <cluster-api-key>` — mtime-cached read from
 *     `/var/lib/generacy/cluster-api-key`.
 *   - `AbortController`-driven per-request timeout (5000 ms default).
 *   - **No client-side retry** — retry lives in the MCP tool per plan D-2 /
 *     research R2. The client is single-call.
 *
 * Error model: two typed classes.
 *   - `CloudTransportError` — network / DNS / timeout / cloud 5xx / missing
 *     API key. Route maps to HTTP 502 → MCP tool retries → after exhaustion,
 *     `class: 'query-unreachable'`.
 *   - `CloudRequestError` — 4xx from cloud OR 2xx with malformed body. Route
 *     maps to HTTP 500 → MCP tool surfaces `class: 'internal'`.
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { stat, readFile } from 'node:fs/promises';
import type { GateType } from '@generacy-ai/cockpit';

const DEFAULT_API_KEY_PATH = '/var/lib/generacy/cluster-api-key';
const DEFAULT_TIMEOUT_MS = 5000;
const CLOUD_PATH_PREFIX = '/api/clusters';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Network / DNS / timeout / cloud 5xx / missing cluster API key. */
export class CloudTransportError extends Error {
  readonly cause?: unknown;
  readonly httpStatus?: number;
  constructor(message: string, details?: { cause?: unknown; httpStatus?: number }) {
    super(message);
    this.name = 'CloudTransportError';
    if (details?.cause !== undefined) this.cause = details.cause;
    if (details?.httpStatus !== undefined) this.httpStatus = details.httpStatus;
  }
}

/** 4xx from cloud, or 2xx with malformed body. Indicates a cluster-side bug. */
export class CloudRequestError extends Error {
  readonly httpStatus?: number;
  constructor(message: string, details?: { httpStatus?: number }) {
    super(message);
    this.name = 'CloudRequestError';
    if (details?.httpStatus !== undefined) this.httpStatus = details.httpStatus;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GetGateStatusInput {
  issueRef: string;
  gateType: GateType;
  generation: string;
}

/** Raw cloud response for status mode — pre-collapse (7 cloud statuses). */
export interface CloudGateStatusResponse {
  gateId: string | null;
  status:
    | 'open'
    | 'answered'
    | 'delivered'
    | 'applied'
    | 'superseded'
    | 'failed'
    | 'expired'
    | null;
}

export interface ListGatesInput {
  issueRef: string;
  gateType?: GateType;
}

/** Raw cloud response for list mode — entries carry the 7-cloud-status vocab. */
export interface CloudGateListEntry {
  gateId: string;
  gateType: GateType;
  generation: string;
  status:
    | 'open'
    | 'answered'
    | 'delivered'
    | 'applied'
    | 'superseded'
    | 'failed'
    | 'expired';
}

export interface CloudGateListResponse {
  gates: CloudGateListEntry[];
  truncated?: boolean;
}

export interface CloudGateQueryClient {
  getGateStatus(input: GetGateStatusInput): Promise<CloudGateStatusResponse>;
  listGates(input: ListGatesInput): Promise<CloudGateListResponse>;
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

interface HttpOutcome {
  status: number;
  body: string;
}

export type HttpsRequestImpl = (
  options: https.RequestOptions,
  callback?: (res: http.IncomingMessage) => void,
) => http.ClientRequest;

export interface CreateCloudGateQueryClientOptions {
  /** Cloud-side cluster id (from `cluster.json`). */
  clusterId: string;
  /** Override API URL env var name. Defaults to `GENERACY_API_URL`. */
  apiUrlEnv?: string;
  /** Override the cluster API key file path. */
  apiKeyPath?: string;
  /** Per-request timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
  /** Test seam — override the `https.request` implementation. */
  httpsRequestImpl?: HttpsRequestImpl;
  /** Test seam — override the `http.request` implementation. */
  httpRequestImpl?: HttpsRequestImpl;
  /** Log sink. Defaults to `console`. */
  logger?: {
    info: (obj: Record<string, unknown>) => void;
    warn: (obj: Record<string, unknown>) => void;
  };
}

interface CachedKey {
  value: string;
  mtimeMs: number;
}

export function createCloudGateQueryClient(
  options: CreateCloudGateQueryClientOptions,
): CloudGateQueryClient {
  const apiUrlEnv = options.apiUrlEnv ?? 'GENERACY_API_URL';
  const apiKeyPath = options.apiKeyPath ?? DEFAULT_API_KEY_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const httpsRequestImpl = options.httpsRequestImpl ?? https.request;
  const httpRequestImpl = options.httpRequestImpl ?? http.request;
  const logger = options.logger ?? {
    info: (obj) => console.log(JSON.stringify(obj)),
    warn: (obj) => console.warn(JSON.stringify(obj)),
  };

  let cachedKey: CachedKey | undefined;

  async function readApiKey(): Promise<string> {
    try {
      const st = await stat(apiKeyPath);
      const mtimeMs = st.mtime.getTime();
      if (cachedKey === undefined || cachedKey.mtimeMs !== mtimeMs) {
        const raw = await readFile(apiKeyPath, 'utf8');
        const value = raw.replace(/\r?\n+$/, '');
        if (!value) {
          throw new CloudTransportError(
            `Cluster API key file at ${apiKeyPath} is empty`,
          );
        }
        cachedKey = { value, mtimeMs };
      }
      return cachedKey.value;
    } catch (err) {
      if (err instanceof CloudTransportError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      throw new CloudTransportError(
        `Cluster API key file at ${apiKeyPath} is missing or unreadable`,
        { cause: code ?? err },
      );
    }
  }

  function buildUrl(query: Record<string, string | undefined>): URL {
    const raw = process.env[apiUrlEnv];
    if (!raw) {
      throw new CloudTransportError(
        `${apiUrlEnv} is not set — cannot reach cloud gate-query endpoint`,
      );
    }
    let base: URL;
    try {
      base = new URL(`${CLOUD_PATH_PREFIX}/${encodeURIComponent(options.clusterId)}/cockpit/gates`, raw);
    } catch (err) {
      throw new CloudTransportError(
        `Invalid ${apiUrlEnv}: ${(err as Error).message}`,
      );
    }
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) base.searchParams.set(k, v);
    }
    return base;
  }

  function performGet(url: URL, apiKey: string): Promise<HttpOutcome> {
    const isHttps = url.protocol === 'https:';
    const requester = isHttps ? httpsRequestImpl : httpRequestImpl;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return new Promise((resolve, reject) => {
      const req = requester(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: 'application/json',
          },
          signal: controller.signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            clearTimeout(timer);
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        },
      );
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    });
  }

  async function get(query: Record<string, string | undefined>, mode: 'status' | 'list'): Promise<unknown> {
    const start = Date.now();
    // Read API key FIRST so a missing key short-circuits (fail closed).
    const apiKey = await readApiKey();
    const url = buildUrl(query);

    let outcome: HttpOutcome;
    try {
      outcome = await performGet(url, apiKey);
    } catch (err) {
      const cause = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      logger.warn({
        event: 'cockpit-gate-query',
        result: 'error',
        errorCode: 'CLOUD_UNREACHABLE',
        mode,
        durationMs: Date.now() - start,
      });
      throw new CloudTransportError(
        `Cloud gate-query endpoint unreachable (${cause})`,
        { cause },
      );
    }

    if (outcome.status >= 500 && outcome.status < 600) {
      logger.warn({
        event: 'cockpit-gate-query',
        result: 'error',
        errorCode: 'CLOUD_UPSTREAM_ERROR',
        mode,
        httpStatus: outcome.status,
        durationMs: Date.now() - start,
      });
      throw new CloudTransportError(
        `Cloud upstream error (HTTP ${outcome.status})`,
        { httpStatus: outcome.status },
      );
    }
    if (outcome.status >= 400 && outcome.status < 500) {
      logger.warn({
        event: 'cockpit-gate-query',
        result: 'error',
        errorCode: 'CLOUD_REQUEST_INVALID',
        mode,
        httpStatus: outcome.status,
        durationMs: Date.now() - start,
      });
      throw new CloudRequestError(
        `Cloud returned ${outcome.status} for gate-query request`,
        { httpStatus: outcome.status },
      );
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      throw new CloudRequestError(
        `Cloud returned unexpected status ${outcome.status}`,
        { httpStatus: outcome.status },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.body);
    } catch {
      logger.warn({
        event: 'cockpit-gate-query',
        result: 'error',
        errorCode: 'CLOUD_RESPONSE_INVALID',
        mode,
        httpStatus: outcome.status,
        durationMs: Date.now() - start,
      });
      throw new CloudRequestError('Cloud returned a non-JSON body');
    }

    logger.info({
      event: 'cockpit-gate-query',
      result: 'ok',
      mode,
      httpStatus: outcome.status,
      durationMs: Date.now() - start,
    });

    return parsed;
  }

  return {
    async getGateStatus(input): Promise<CloudGateStatusResponse> {
      const raw = (await get(
        {
          issueRef: input.issueRef,
          gateType: input.gateType,
          generation: input.generation,
        },
        'status',
      )) as unknown;

      if (raw === null || typeof raw !== 'object') {
        throw new CloudRequestError('Cloud status response is not an object');
      }
      const obj = raw as Record<string, unknown>;
      const gateId = obj['gateId'];
      const status = obj['status'];
      if (gateId !== null && typeof gateId !== 'string') {
        throw new CloudRequestError('Cloud status response has invalid gateId');
      }
      if (status !== null && typeof status !== 'string') {
        throw new CloudRequestError('Cloud status response has invalid status');
      }
      return {
        gateId: (gateId as string | null) ?? null,
        status: (status as CloudGateStatusResponse['status']) ?? null,
      };
    },

    async listGates(input): Promise<CloudGateListResponse> {
      const raw = (await get(
        {
          issueRef: input.issueRef,
          gateType: input.gateType,
        },
        'list',
      )) as unknown;

      if (raw === null || typeof raw !== 'object') {
        throw new CloudRequestError('Cloud list response is not an object');
      }
      const obj = raw as Record<string, unknown>;
      const gates = obj['gates'];
      if (!Array.isArray(gates)) {
        throw new CloudRequestError('Cloud list response is missing `gates` array');
      }
      const parsed: CloudGateListEntry[] = [];
      for (const entry of gates) {
        if (entry === null || typeof entry !== 'object') {
          throw new CloudRequestError('Cloud list response contains a non-object entry');
        }
        const e = entry as Record<string, unknown>;
        const gateId = e['gateId'];
        const gateType = e['gateType'];
        const generation = e['generation'];
        const status = e['status'];
        if (typeof gateId !== 'string') {
          throw new CloudRequestError('Cloud list entry has invalid gateId');
        }
        if (typeof gateType !== 'string') {
          throw new CloudRequestError('Cloud list entry has invalid gateType');
        }
        if (typeof status !== 'string') {
          throw new CloudRequestError('Cloud list entry has invalid status');
        }
        // Cloud may serialize numeric `generation` (e.g. phase-queue) — coerce.
        const generationString =
          typeof generation === 'string'
            ? generation
            : typeof generation === 'number'
              ? String(generation)
              : null;
        if (generationString === null) {
          throw new CloudRequestError('Cloud list entry has invalid generation');
        }
        parsed.push({
          gateId,
          gateType: gateType as GateType,
          generation: generationString,
          status: status as CloudGateListEntry['status'],
        });
      }
      const truncated = obj['truncated'];
      const result: CloudGateListResponse = { gates: parsed };
      if (truncated === true) result.truncated = true;
      return result;
    },
  };
}
