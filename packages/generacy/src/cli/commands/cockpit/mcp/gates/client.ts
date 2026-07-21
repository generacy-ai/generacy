/**
 * Verb-agnostic HTTP client for the two remote-gate MCP tools (#1022).
 *
 * `invokeGate` POSTs a JSON body to the orchestrator and translates the
 * outcome into the standard `ToolResult<T>` envelope. The verb-specific
 * response-shape assertion (e.g. `cockpit_gate_open` requires `{gateId, status}`)
 * is done by the CALLER, not here — this file speaks only HTTP and status
 * codes.
 *
 * Error mapping table (contracts/error-mapping.md):
 *   Thrown AbortError                → transport (timeout detail)
 *   Thrown other                     → transport (err.message first line)
 *   2xx + non-JSON body              → internal
 *   2xx + JSON                       → ok
 *   HTTP 400 / 409                   → invalid-args
 *   HTTP 404                         → unknown-gate
 *   Other 4xx (401/403/405/410/429…) → internal
 *   HTTP 5xx                         → transport
 */
import type { ToolResult } from '../errors.js';
import type { GateClientOptions } from './options.js';

export interface GateRequest {
  method: 'POST';
  path: string;
  body: unknown;
}

export async function invokeGate<T>(
  request: GateRequest,
  options: GateClientOptions,
): Promise<ToolResult<T>> {
  const url = new URL(request.path, options.baseUrl).toString();
  const verb = verbFromPath(request.path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  let res: Response;
  try {
    res = await options.fetchImpl(url, {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (isAbortError(err)) {
      return {
        status: 'error',
        class: 'transport',
        detail: `orchestrator request timed out after ${options.timeoutMs}ms`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', class: 'transport', detail: firstLineOr(msg, 'network error') };
  } finally {
    clearTimeout(timer);
  }

  if (res.ok) {
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'error', class: 'transport', detail: firstLineOr(msg, 'response read failed') };
    }
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      return {
        status: 'error',
        class: 'internal',
        detail: `orchestrator returned non-JSON ${verb} response`,
      };
    }
    return { status: 'ok', data: parsed as T };
  }

  // Non-2xx branch — read body once, then classify.
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    bodyText = '';
  }
  const detail = firstLineOr(bodyText, `HTTP ${res.status}`);

  if (res.status === 400) return { status: 'error', class: 'invalid-args', detail };
  if (res.status === 404) return { status: 'error', class: 'unknown-gate', detail };
  if (res.status === 409) return { status: 'error', class: 'invalid-args', detail };
  if (res.status >= 500 && res.status < 600) {
    return { status: 'error', class: 'transport', detail };
  }
  if (res.status >= 400 && res.status < 500) {
    return { status: 'error', class: 'internal', detail };
  }
  // Fallthrough (e.g. 3xx redirect that reached us with res.ok === false).
  return { status: 'error', class: 'internal', detail };
}

function isAbortError(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError';
}

function verbFromPath(path: string): 'gate-open' | 'ack' | 'gate' {
  if (/\/ack$/.test(path)) return 'ack';
  if (/\/cockpit\/gates\/?$/.test(path)) return 'gate-open';
  return 'gate';
}

function firstLineOr(stdout: string, fallback: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return fallback;
  const first = trimmed.split('\n')[0];
  return first != null && first.length > 0 ? first : fallback;
}
