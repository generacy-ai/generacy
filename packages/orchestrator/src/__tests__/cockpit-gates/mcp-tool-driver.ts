/**
 * Thin direct-import wrapper around the four MCP gate tool handlers.
 *
 * Exists per clarification Q2=C for the #1068 harness — drives the tools by
 * direct function import rather than spawning `claude` or the MCP protocol.
 * Centralizes the deps plumbing in one place.
 *
 * D-2-a: direct TypeScript import from the source path resolves through the
 * workspace symlink at test time. Verified in T002 before wiring here.
 *
 * See specs/1068-problem-gate-identity-work/contracts/mcp-tool-driver.md and
 * specs/1068-problem-gate-identity-work/data-model.md §E4.
 */
import { deriveGateId, deriveGateKey, type GateType } from '@generacy-ai/cockpit';
import { cockpitGateOpen, type CockpitGateOpenData } from '../../../../generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.js';
import { cockpitGateAck, type CockpitGateAckData } from '../../../../generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.js';
import { cockpitGateStatus } from '../../../../generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.js';
import { cockpitGateList } from '../../../../generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.js';
import type {
  CockpitGateStatusData,
  CockpitGateListData,
} from '../../../../generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.js';
import type { ToolResult } from '../../../../generacy/src/cli/commands/cockpit/mcp/errors.js';

export interface McpToolDriverOptions {
  /** Light-orchestrator base URL, from `ScenarioContext.orchestratorUrl`. */
  baseUrl: string;
  /** Injected fetch — default `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * #1068 — optional test-only side channel: on every successful `gateOpen`
   * call whose input carries a non-empty `runId`, the driver records
   * `<gateId → runId>` here. The `runId` field is stripped by the wire schema
   * (both cluster-side `GateOpenWireSchema` and the transported `GateOpenSchema`),
   * so this is the only way the fake-cloud store can recover it. Real callers
   * of the tool never see this map — it exists purely to preserve the
   * `runId`-vs-generation attribution inside the harness.
   */
  runIdByGateId?: Map<string, string>;
}

export interface McpToolDriver {
  gateOpen(input: unknown): Promise<ToolResult<CockpitGateOpenData>>;
  gateAck(input: unknown): Promise<ToolResult<CockpitGateAckData>>;
  gateStatus(input: unknown): Promise<ToolResult<CockpitGateStatusData>>;
  gateList(input: unknown): Promise<ToolResult<CockpitGateListData>>;
}

function extractRunId(input: unknown): string | undefined {
  if (input == null || typeof input !== 'object') return undefined;
  const val = (input as { runId?: unknown }).runId;
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

/**
 * Compute the tool-side gateId that `cockpit_gate_open` will derive from
 * `input`. Mirrors the tool's own derivation at
 * `cockpit_gate_open.ts:82-83` — same helpers, same argument order. Returns
 * `null` when the input shape doesn't carry enough info (never happens for
 * valid tool inputs but keeps this side-channel tolerant).
 */
function precomputeGateId(input: unknown, runId: string): string | null {
  if (input == null || typeof input !== 'object') return null;
  const i = input as {
    issueRef?: unknown;
    gateType?: unknown;
    generation?: unknown;
  };
  if (typeof i.issueRef !== 'string' || typeof i.gateType !== 'string') return null;
  const gen =
    typeof i.generation === 'string' || typeof i.generation === 'number'
      ? String(i.generation)
      : '';
  const gateKey = deriveGateKey(
    i.issueRef,
    i.gateType as GateType,
    gen,
    runId,
  );
  return deriveGateId(gateKey);
}

export function createMcpToolDriver(opts: McpToolDriverOptions): McpToolDriver {
  const deps = {
    orchestratorUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl ?? fetch,
  };
  const runIdMap = opts.runIdByGateId;
  return {
    gateOpen(input) {
      // Populate the runId side channel BEFORE calling the tool: the tool's
      // POST to /cockpit/gates fires the outbound relay frame synchronously
      // (before the POST response returns), so the fake-peer callback fires
      // before this method resolves. Pre-computing the gateId ensures the
      // callback sees the mapping.
      if (runIdMap != null) {
        const runId = extractRunId(input);
        if (runId !== undefined) {
          const gateId = precomputeGateId(input, runId);
          if (gateId != null) runIdMap.set(gateId, runId);
        }
      }
      return cockpitGateOpen(input, deps);
    },
    gateAck: (input) => cockpitGateAck(input, deps),
    gateStatus: (input) => cockpitGateStatus(input, deps),
    gateList: (input) => cockpitGateList(input, deps),
  };
}
