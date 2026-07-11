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
