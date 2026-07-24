/**
 * `cockpit_gate_status` MCP tool (#1038 T040).
 *
 * Read-only. Asks the cloud: "is the gate for `(issueRef, gateType, generation)`
 * currently open, answered, or absent?" Used by the agency-side sweep
 * (generacy-ai/agency#450) to skip re-drafting gates already open in the
 * operator inbox.
 *
 * Observer independence (FR-012 / SC-005): this file MUST NOT import from
 *   - `../gates/client.js`         (write-path HTTP client)
 *   - `./cockpit_gate_open.js`
 *   - `./cockpit_gate_ack.js`
 *   - any file whose path contains `retain`
 * Enforced by `../__tests__/observer-independence.test.ts` static import-scan.
 */
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import {
  CockpitGateStatusInputSchema,
  type CockpitGateStatusData,
} from '../gates/query-schemas.js';
import {
  createGateQueryClient,
  isRetryableGateQueryError,
  QueryInvalidArgsError,
  QueryInternalError,
  QueryTransportError,
} from '../gates/query-client.js';
import { QUERY_RETRY_SCHEDULE, withRetry } from '../gates/retry.js';
import { resolveGateOptions } from '../gates/options.js';
import type { BuildMcpServerDeps } from '../server.js';

export function cockpitGateStatus(
  input: unknown,
  deps: BuildMcpServerDeps = {},
): Promise<ToolResult<CockpitGateStatusData>> {
  return wrapToolBoundary<CockpitGateStatusData>(async () => {
    const parsed = CockpitGateStatusInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }

    // The MCP-boundary schema allows `generation: string | number`; the query
    // client wire is JSON so it coerces via `String()` before serializing.
    const queryInput = {
      issueRef: parsed.data.issueRef,
      gateType: parsed.data.gateType,
      generation: parsed.data.generation,
    };

    const options = resolveGateOptions(deps);
    const client = createGateQueryClient(options);

    try {
      const data = await withRetry({
        fn: () => client.getGateStatus(queryInput),
        schedule: QUERY_RETRY_SCHEDULE,
        shouldRetry: isRetryableGateQueryError,
      });
      return { status: 'ok', data };
    } catch (err) {
      if (err instanceof QueryInvalidArgsError) {
        return { status: 'error', class: 'invalid-args', detail: err.message };
      }
      if (err instanceof QueryInternalError) {
        return { status: 'error', class: 'internal', detail: err.message };
      }
      if (err instanceof QueryTransportError) {
        return {
          status: 'error',
          class: 'query-unreachable',
          detail: err.message,
          hint: 'query gate status after connectivity is restored',
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'error', class: 'internal', detail: msg };
    }
  });
}
