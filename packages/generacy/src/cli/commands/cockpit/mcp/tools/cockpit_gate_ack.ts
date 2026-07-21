/**
 * `cockpit_gate_ack` MCP tool (#1022).
 *
 * Thin HTTP client: validates `{gateId, outcome, detail?}` (strict), POSTs to
 * `POST /cockpit/gates/:id/ack`, forwards the orchestrator's opaque response
 * inside the `ToolResult` envelope. Response body shape is NOT asserted at
 * this boundary (contracts/cockpit_gate_ack.md § "Output — success").
 */
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import { CockpitGateAckInputSchema } from '../schemas.js';
import { invokeGate } from '../gates/client.js';
import { resolveGateOptions } from '../gates/options.js';
import type { BuildMcpServerDeps } from '../server.js';

export type CockpitGateAckData = Record<string, unknown>;

export function cockpitGateAck(
  input: unknown,
  deps: BuildMcpServerDeps = {},
): Promise<ToolResult<CockpitGateAckData>> {
  return wrapToolBoundary<CockpitGateAckData>(async () => {
    const parsed = CockpitGateAckInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }

    const options = resolveGateOptions(deps);
    const body: { outcome: string; detail?: string } = { outcome: parsed.data.outcome };
    if (parsed.data.detail !== undefined) body.detail = parsed.data.detail;

    return invokeGate<CockpitGateAckData>(
      {
        method: 'POST',
        path: `/cockpit/gates/${encodeURIComponent(parsed.data.gateId)}/ack`,
        body,
      },
      options,
    );
  });
}
