/**
 * `cockpit_gate_list` MCP tool (#1038).
 *
 * Read-only enumeration of all non-terminal gates for a given issueRef,
 * project-wide (predecessor-cluster takeover-safe). The PRIMARY sweep primitive
 * (Q4→B / INV-5): the sweep queries by (issueRef, gateType) prefix and skips
 * drafting when any matching gate is currently `open`, regardless of generation.
 *
 * INV-2 — NEVER returns `data.gates = []` on transport failure. Sustained
 * cloud unreachability surfaces as `class: 'query-unreachable'`.
 *
 * Contract: specs/1038-part-cockpit-remote-gates/contracts/cockpit_gate_list.md
 */
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import { CockpitGateListInputSchema } from '../schemas.js';
import { resolveGateOptions } from '../gates/options.js';
import { queryGateList } from '../gates/query-client.js';
import type { GateListResponse } from '../gates/schemas.js';
import type { BuildMcpServerDeps } from '../server.js';

export function cockpitGateList(
  input: unknown,
  deps: BuildMcpServerDeps = {},
): Promise<ToolResult<GateListResponse>> {
  return wrapToolBoundary<GateListResponse>(async () => {
    const parsed = CockpitGateListInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }
    const s = parsed.data;
    const options = resolveGateOptions(deps);
    const result = await queryGateList(
      {
        issueRef: s.issueRef,
        ...(s.gateType !== undefined ? { gateType: s.gateType } : {}),
      },
      options,
    );
    if ('class' in result) {
      return { status: 'error', class: result.class, detail: result.detail };
    }
    // Client-side gateType filter: guards against a cloud responder that
    // ignores the optional gateType query param.
    const filtered =
      s.gateType !== undefined
        ? result.gates.filter((g) => g.gateType === s.gateType)
        : result.gates;
    return { status: 'ok', data: { gates: filtered } };
  });
}
