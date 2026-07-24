/**
 * `cockpit_gate_status` MCP tool (#1038).
 *
 * Cheap, body-free lookup that answers "is this specific natural gate
 * (issueRef, gateType, generation) currently open, already answered, or
 * absent?" against the cloud (Firestore) source of truth.
 *
 * INV-2 — NEVER returns `absent` on transport failure. Sustained cloud
 * unreachability surfaces as `class: 'query-unreachable'`.
 *
 * Contract: specs/1038-part-cockpit-remote-gates/contracts/cockpit_gate_status.md
 */
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import { CockpitGateStatusInputSchema } from '../schemas.js';
import { resolveGateOptions } from '../gates/options.js';
import { queryGateStatus } from '../gates/query-client.js';
import type { GateStatusResponse } from '../gates/schemas.js';
import type { BuildMcpServerDeps } from '../server.js';

export function cockpitGateStatus(
  input: unknown,
  deps: BuildMcpServerDeps = {},
): Promise<ToolResult<GateStatusResponse>> {
  return wrapToolBoundary<GateStatusResponse>(async () => {
    const parsed = CockpitGateStatusInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }
    const s = parsed.data;
    const options = resolveGateOptions(deps);
    const result = await queryGateStatus(
      {
        issueRef: s.issueRef,
        gateType: s.gateType,
        generation: String(s.generation),
      },
      options,
    );
    if ('class' in result) {
      return { status: 'error', class: result.class, detail: result.detail };
    }
    return { status: 'ok', data: result };
  });
}
