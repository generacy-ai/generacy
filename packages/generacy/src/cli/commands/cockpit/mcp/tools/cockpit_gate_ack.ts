/**
 * `cockpit_gate_ack` MCP tool (#1022 / #843).
 *
 * Assembles the frozen gate-outcome wire record (Shape 2, THE ACK) and POSTs it
 * to `POST /cockpit/gates/:id/ack`, which relays it verbatim to the cloud. The
 * caller passes `{gateId, outcome, detail?, at?}`; the tool sets
 * `type:'gate-outcome'` and defaults `at` to now() when omitted. This REPLACES
 * the old invented gate-ack (`kind`/`ackedAt`/`generation`, free-string
 * outcome). Response body shape is NOT asserted at this boundary
 * (contracts/cockpit_gate_ack.md § "Output — success").
 */
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import { CockpitGateAckInputSchema } from '../schemas.js';
import { invokeGate } from '../gates/client.js';
import { resolveGateOptions } from '../gates/options.js';
import { GateOutcomeWireSchema, type GateOutcomeWire } from '../gates/schemas.js';
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

    const s = parsed.data;
    const record: GateOutcomeWire = {
      type: 'gate-outcome',
      gateId: s.gateId,
      outcome: s.outcome,
      ...(s.detail !== undefined ? { detail: s.detail } : {}),
      at: s.at ?? new Date().toISOString(),
    };

    const wire = GateOutcomeWireSchema.safeParse(record);
    if (!wire.success) {
      return {
        status: 'error',
        class: 'internal',
        detail: `assembled gate-outcome record failed frozen-shape validation: ${wire.error.issues
          .map((i) => i.message)
          .join('; ')}`,
      };
    }

    const options = resolveGateOptions(deps);
    return invokeGate<CockpitGateAckData>(
      {
        method: 'POST',
        path: `/cockpit/gates/${encodeURIComponent(s.gateId)}/ack`,
        body: wire.data,
      },
      options,
    );
  });
}
