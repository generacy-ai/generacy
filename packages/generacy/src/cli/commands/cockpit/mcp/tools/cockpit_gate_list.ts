/**
 * `cockpit_gate_list` MCP tool (#1038 T041).
 *
 * Read-only. Asks the cloud: "which non-terminal gates exist for this
 * issueRef (and optional gateType)?" Primary sweep primitive per Q4 → B:
 * the sweep uses this to skip drafting whenever any gate for
 * `(issueRef, gateType)` is currently non-terminal, regardless of generation
 * match — this kills the gen=1 cutover duplicate without a cloud migration.
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
  CockpitGateListInputSchema,
  type CockpitGateListData,
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

export function cockpitGateList(
  input: unknown,
  deps: BuildMcpServerDeps = {},
): Promise<ToolResult<CockpitGateListData>> {
  return wrapToolBoundary<CockpitGateListData>(async () => {
    const parsed = CockpitGateListInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }

    const options = resolveGateOptions(deps);
    const client = createGateQueryClient(options);

    try {
      const data = await withRetry({
        fn: () => client.listGates(parsed.data),
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
          hint: 'query gate list after connectivity is restored',
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'error', class: 'internal', detail: msg };
    }
  });
}
