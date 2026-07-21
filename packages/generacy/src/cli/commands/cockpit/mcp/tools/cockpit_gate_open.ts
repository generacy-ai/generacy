/**
 * `cockpit_gate_open` MCP tool (#1022).
 *
 * Thin HTTP client: validates the caller's gate record, POSTs to the
 * orchestrator's `POST /cockpit/gates` route, returns the response inside the
 * standard `ToolResult` envelope. No local business logic, no persistence,
 * no CLI-verb twin.
 *
 * Contract: contracts/cockpit_gate_open.md
 * Error mapping: contracts/error-mapping.md (mirror of `gates/client.ts`)
 */
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import { CockpitGateOpenInputSchema } from '../schemas.js';
import { invokeGate } from '../gates/client.js';
import { resolveGateOptions } from '../gates/options.js';
import { GateOpenResponseSchema } from '../gates/schemas.js';
import type { BuildMcpServerDeps } from '../server.js';

export interface CockpitGateOpenData {
  gateId: string;
  status: string;
  [k: string]: unknown;
}

export function cockpitGateOpen(
  input: unknown,
  deps: BuildMcpServerDeps = {},
): Promise<ToolResult<CockpitGateOpenData>> {
  return wrapToolBoundary<CockpitGateOpenData>(async () => {
    const parsed = CockpitGateOpenInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }

    const options = resolveGateOptions(deps);
    const result = await invokeGate<CockpitGateOpenData>(
      { method: 'POST', path: '/cockpit/gates', body: parsed.data },
      options,
    );

    if (result.status !== 'ok') return result;

    const envelope = GateOpenResponseSchema.safeParse(result.data);
    if (!envelope.success) {
      return {
        status: 'error',
        class: 'internal',
        detail: 'orchestrator returned malformed gate-open response',
      };
    }
    return { status: 'ok', data: envelope.data as CockpitGateOpenData };
  });
}
