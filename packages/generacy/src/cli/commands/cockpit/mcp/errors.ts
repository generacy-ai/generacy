/**
 * Typed error results for the cockpit MCP tool boundary.
 *
 * Every tool returns `ToolResult<T>` — either `ToolOkResult<T>` (status: 'ok')
 * or `ToolErrorResult` (status: 'error'). Bare thrown exceptions never reach
 * the JSON-RPC transport; `wrapToolBoundary` converts them into an
 * `internal`-class error result.
 *
 * `mapCockpitExitToToolError` translates the `CockpitExit` codes used by the
 * CLI verbs (1 = transport, 2 = argument/parse, 3 = gate refusal) into
 * discriminated tool-error classes.
 */
import { isCockpitExit, type CockpitExit } from '../exit.js';

export type ErrorClass =
  | 'invalid-args'
  | 'wrong-kind'
  | 'unknown-gate'
  | 'not-an-epic'
  | 'gate-refusal'
  | 'transport'
  | 'invalid-cursor'
  | 'not-worker'
  | 'contended'
  | 'scope-not-found'
  | 'internal';

export interface ToolOkResult<T> {
  status: 'ok';
  data: T;
}

export interface ToolErrorResult {
  status: 'error';
  class: ErrorClass;
  detail: string;
  hint?: string;
}

export type ToolResult<T> = ToolOkResult<T> | ToolErrorResult;

/** Map a `CockpitExit` from the CLI verb into a typed tool-error result. */
export function mapCockpitExitToToolError(exit: CockpitExit): ToolErrorResult {
  const detail = exit.message;
  switch (exit.code) {
    case 1:
      return { status: 'error', class: 'transport', detail };
    case 2:
      return { status: 'error', class: 'invalid-args', detail };
    case 3:
      return { status: 'error', class: 'gate-refusal', detail };
    default:
      return { status: 'error', class: 'internal', detail };
  }
}

/**
 * Wrap a tool handler so that any thrown Error (including `CockpitExit`)
 * becomes a typed `ToolErrorResult`. The MCP transport never sees an
 * uncaught throw from a wrapped handler.
 */
export async function wrapToolBoundary<T>(
  fn: () => Promise<ToolResult<T>>,
): Promise<ToolResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (isCockpitExit(err)) {
      return mapCockpitExitToToolError(err);
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { status: 'error', class: 'internal', detail };
  }
}

/**
 * #928 — Envelope-mapping helper.
 *
 * Translates the CLI verb's `RunMergeResult` (`{ exitCode, stdout }`) into the
 * MCP `ToolResult<T>` envelope. THIS TABLE IS THE TRANSPORT CONTRACT (Q4 → B):
 * any new `reason` string introduced in `runMerge` must appear here, or fall
 * through to `class: 'invalid-args'` (which is loud enough for tests to catch).
 *
 * Mapping (see data-model.md §toMcpResult):
 *   exit=0 → ok, data: parsed
 *   exit=2 + reason='pr-number'          → wrong-kind (with `hint`)
 *   exit=2 + reason∈{unresolved, ambiguous-resolution, pr-is-draft, checks-failing}
 *                                         → gate-refusal
 *   exit=2 + other/missing reason        → invalid-args
 *   exit=3                               → gate-refusal
 *   exit=1                               → transport
 *   exit≥4                               → internal
 *   non-JSON stdout                      → internal
 */
export function toMcpResult<T>(
  cliJsonStdout: string,
  exitCode: number,
): ToolResult<T> {
  let parsed: unknown = null;
  let parseFailed = false;
  try {
    parsed = cliJsonStdout.trim().length === 0 ? null : JSON.parse(cliJsonStdout);
  } catch {
    parseFailed = true;
  }

  if (exitCode === 0) {
    if (parseFailed) {
      return {
        status: 'error',
        class: 'internal',
        detail: 'CLI produced non-JSON stdout on success exit',
      };
    }
    return { status: 'ok', data: parsed as T };
  }

  const detailFallback = firstLineOr(cliJsonStdout, 'CLI reported an error');

  if (exitCode === 1) {
    // Legacy: several cockpit verbs (notably `runMerge`) still use exit-1
    // for resolver-driven gate refusals. Distinguish by the presence of a
    // red-payload JSON with a known refusal `reason` — that's a gate
    // refusal, not a transport error.
    if (!parseFailed) {
      const reason = extractString(parsed, 'reason');
      if (reason !== null && isKnownGateRefusalReason(reason)) {
        return {
          status: 'error',
          class: 'gate-refusal',
          detail: describeGateRefusal(parsed, reason),
        };
      }
    }
    return { status: 'error', class: 'transport', detail: detailFallback };
  }

  if (exitCode === 2) {
    if (parseFailed) {
      return {
        status: 'error',
        class: 'internal',
        detail: 'CLI produced non-JSON stdout on error exit',
      };
    }
    const reason = extractString(parsed, 'reason');
    if (reason === 'pr-number') {
      const hint = extractString(parsed, 'hint') ?? undefined;
      const err: ToolErrorResult = {
        status: 'error',
        class: 'wrong-kind',
        detail: hint ?? `input is a pull request; pass the issue number`,
      };
      if (hint !== undefined) err.hint = hint;
      return err;
    }
    if (
      reason === 'unresolved' ||
      reason === 'ambiguous-resolution' ||
      reason === 'pr-is-draft' ||
      reason === 'checks-failing' ||
      reason === 'missing-label' ||
      reason === 'pr-flag-linkage-refused' ||
      reason === 'pr-flag-closed-unmerged'
    ) {
      return {
        status: 'error',
        class: 'gate-refusal',
        detail: describeGateRefusal(parsed, reason),
      };
    }
    return {
      status: 'error',
      class: 'invalid-args',
      detail: describeInvalidArgs(parsed, detailFallback),
    };
  }

  if (exitCode === 3) {
    if (parseFailed) {
      return { status: 'error', class: 'gate-refusal', detail: detailFallback };
    }
    const reason = extractString(parsed, 'reason');
    return {
      status: 'error',
      class: 'gate-refusal',
      detail: reason !== null ? describeGateRefusal(parsed, reason) : detailFallback,
    };
  }

  return { status: 'error', class: 'internal', detail: detailFallback };
}

function firstLineOr(stdout: string, fallback: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return fallback;
  const first = trimmed.split('\n')[0];
  return first != null && first.length > 0 ? first : fallback;
}

function extractString(raw: unknown, field: string): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const value = (raw as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

function describeGateRefusal(raw: unknown, reason: string): string {
  const message = extractString(raw, 'message');
  if (message !== null) return message;
  return reason;
}

function isKnownGateRefusalReason(reason: string): boolean {
  return (
    reason === 'unresolved' ||
    reason === 'ambiguous-resolution' ||
    reason === 'pr-is-draft' ||
    reason === 'checks-failing' ||
    reason === 'missing-label' ||
    reason === 'pr-flag-linkage-refused' ||
    reason === 'pr-flag-closed-unmerged'
  );
}

function describeInvalidArgs(raw: unknown, fallback: string): string {
  const detail = extractString(raw, 'detail');
  if (detail !== null) return detail;
  const message = extractString(raw, 'message');
  if (message !== null) return message;
  return fallback;
}
