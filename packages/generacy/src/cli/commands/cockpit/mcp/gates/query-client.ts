/**
 * GET-shaped HTTP client for the two read-only gate-status query tools (#1038).
 *
 * Distinct from `client.ts` (POST-shaped) because the POST client's fixed
 * error-mapping table cannot express `'query-unreachable'` retries without
 * conflating with POST semantics. Both clients share `resolveGateOptions` and
 * the `ErrorClass` enum — no duplicated infra.
 *
 * Retry cadence (frozen per spec FR-011 / R3):
 *   3 attempts, 500ms → 1500ms → 3000ms backoffs with ±10% jitter,
 *   5000ms per-attempt timeout, ~5s total wall time.
 *
 * INV-2 — This client NEVER returns a success payload with `absent`/`gates:[]`
 * on transport failure. Sustained failure surfaces as
 * `{ class: 'query-unreachable' }`.
 */
import type { ErrorClass } from '../errors.js';
import type { GateClientOptions } from './options.js';
import {
  GateStatusResponseSchema,
  GateListResponseSchema,
  type GateStatusResponse,
  type GateListResponse,
} from './schemas.js';

// Backoff constants — spec-side. Overridable in tests via _TEST_RETRY_BACKOFFS_MS.
const DEFAULT_RETRY_BACKOFFS_MS = [500, 1500, 3000] as const;
const RETRY_JITTER_FRACTION = 0.1;

// eslint-disable-next-line @typescript-eslint/no-mutable-exports
export let _TEST_RETRY_BACKOFFS_MS: readonly number[] = DEFAULT_RETRY_BACKOFFS_MS;

/** Test-only: overrides the backoff schedule for fast-forwarded retries. */
export function _setTestRetryBackoffs(schedule: readonly number[] | null): void {
  _TEST_RETRY_BACKOFFS_MS = schedule ?? DEFAULT_RETRY_BACKOFFS_MS;
}

export interface QueryError {
  class: ErrorClass;
  detail: string;
}

export interface QueryStatusInput {
  issueRef: string;
  gateType: string;
  generation: string;
}

export interface QueryListInput {
  issueRef: string;
  gateType?: string;
}

export async function queryGateStatus(
  input: QueryStatusInput,
  options: GateClientOptions,
): Promise<GateStatusResponse | QueryError> {
  const params = new URLSearchParams({
    issueRef: input.issueRef,
    mode: 'single',
    gateType: input.gateType,
    generation: input.generation,
  });
  return runQuery(params, options, (raw) => GateStatusResponseSchema.safeParse(raw));
}

export async function queryGateList(
  input: QueryListInput,
  options: GateClientOptions,
): Promise<GateListResponse | QueryError> {
  const params = new URLSearchParams({
    issueRef: input.issueRef,
    mode: 'list',
  });
  if (input.gateType !== undefined) params.set('gateType', input.gateType);
  return runQuery(params, options, (raw) => GateListResponseSchema.safeParse(raw));
}

interface AttemptFailure {
  kind: 'retryable' | 'terminal';
  errorClass: ErrorClass;
  detail: string;
}

async function runQuery<T>(
  params: URLSearchParams,
  options: GateClientOptions,
  validate: (raw: unknown) => { success: true; data: T } | { success: false; error: unknown },
): Promise<T | QueryError> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/cockpit/gates?${params.toString()}`;
  let lastFailure: AttemptFailure = {
    kind: 'retryable',
    errorClass: 'query-unreachable',
    detail: 'no attempt made',
  };

  for (let attempt = 0; attempt < _TEST_RETRY_BACKOFFS_MS.length; attempt++) {
    const outcome = await runAttempt<T>(url, options, validate);
    if ('data' in outcome) return outcome.data;
    lastFailure = outcome;
    if (outcome.kind === 'terminal') {
      return { class: outcome.errorClass, detail: outcome.detail };
    }
    // Retryable — sleep with jitter unless this was the last attempt.
    if (attempt < _TEST_RETRY_BACKOFFS_MS.length - 1) {
      const base = _TEST_RETRY_BACKOFFS_MS[attempt] ?? 0;
      const jitter = base * RETRY_JITTER_FRACTION;
      const wait = Math.max(0, base + (Math.random() * 2 - 1) * jitter);
      if (wait > 0) await sleep(wait);
    }
  }

  return {
    class: 'query-unreachable',
    detail: `query unreachable after ${_TEST_RETRY_BACKOFFS_MS.length} attempts: ${lastFailure.detail}`,
  };
}

async function runAttempt<T>(
  url: string,
  options: GateClientOptions,
  validate: (raw: unknown) => { success: true; data: T } | { success: false; error: unknown },
): Promise<{ data: T } | AttemptFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let res: Response;
  try {
    res = await options.fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (isAbortError(err)) {
      return {
        kind: 'retryable',
        errorClass: 'query-unreachable',
        detail: `attempt timed out after ${options.timeoutMs}ms`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: 'retryable',
      errorClass: 'query-unreachable',
      detail: firstLineOr(msg, 'network error'),
    };
  } finally {
    clearTimeout(timer);
  }

  const status = res.status;
  const bodyText = await safeText(res);

  if (status === 200) {
    let parsed: unknown;
    try {
      parsed = bodyText.length === 0 ? null : JSON.parse(bodyText);
    } catch {
      return {
        kind: 'retryable',
        errorClass: 'internal',
        detail: 'orchestrator returned non-JSON success body',
      };
    }
    const result = validate(parsed);
    if (!result.success) {
      return {
        kind: 'retryable',
        errorClass: 'internal',
        detail: 'orchestrator returned malformed body',
      };
    }
    return { data: result.data };
  }

  if (status >= 400 && status < 500) {
    if (status === 400) {
      return {
        kind: 'terminal',
        errorClass: 'invalid-args',
        detail: firstLineOr(bodyText, `HTTP ${status}`),
      };
    }
    return {
      kind: 'terminal',
      errorClass: 'internal',
      detail: firstLineOr(bodyText, `HTTP ${status}`),
    };
  }

  // 5xx — retryable transport failure.
  return {
    kind: 'retryable',
    errorClass: 'query-unreachable',
    detail: firstLineOr(bodyText, `HTTP ${status}`),
  };
}

function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  return (err as { name?: unknown }).name === 'AbortError';
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function firstLineOr(text: string, fallback: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return fallback;
  const first = trimmed.split('\n')[0];
  return first != null && first.length > 0 ? first : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
