/**
 * `cockpit_gate_open` MCP tool (#1022 / #843).
 *
 * DERIVES the gate identity and assembles the frozen gate-open wire record:
 * the plugin/LLM passes SEMANTIC + presentation fields (issueRef, gateType,
 * generation discriminator, title/body/options/allowFreeText, epicRef,
 * issueTitle, issueUrl, branch?, prNumber?, sessionId, askedAt?); this tool
 * computes gateKey + gateId, sets `type:'gate-open'`, self-validates against the
 * frozen shape, and POSTs the flat record to the orchestrator's
 * `POST /cockpit/gates` route (which relays it verbatim to the cloud). The
 * plugin never hand-builds a sha256.
 *
 * Contract: contracts/cockpit_gate_open.md
 * Wire: tetrad-development/docs/cockpit-remote-gates-plan.md § "Wire contracts".
 * Error mapping: contracts/error-mapping.md (mirror of `gates/client.ts`).
 */
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import { CockpitGateOpenInputSchema } from '../schemas.js';
import { invokeGate } from '../gates/client.js';
import { resolveGateOptions } from '../gates/options.js';
import {
  deriveGateId,
  deriveGateKey,
  GateOpenResponseSchema,
  GateOpenWireSchema,
  type GateOpenWire,
} from '../gates/schemas.js';
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

    const s = parsed.data;
    const gateKey = deriveGateKey(s.issueRef, s.gateType, s.generation);
    const gateId = deriveGateId(gateKey);

    // Assemble the FLAT frozen record. Optional wire fields are omitted (not
    // set to `undefined`) so the serialized frame matches the cloud schema.
    const record: GateOpenWire = {
      type: 'gate-open',
      gateId,
      gateKey,
      gateType: s.gateType,
      epicRef: s.epicRef,
      issueRef: s.issueRef,
      issueTitle: s.issueTitle,
      issueUrl: s.issueUrl,
      ...(s.branch !== undefined ? { branch: s.branch } : {}),
      ...(s.prNumber !== undefined ? { prNumber: s.prNumber } : {}),
      title: s.title,
      body: s.body,
      options: s.options,
      allowFreeText: s.allowFreeText,
      sessionId: s.sessionId,
      askedAt: s.askedAt ?? new Date().toISOString(),
    };

    // Self-check: never emit a frame the cloud would warn-drop as malformed.
    const wire = GateOpenWireSchema.safeParse(record);
    if (!wire.success) {
      return {
        status: 'error',
        class: 'internal',
        detail: `assembled gate-open record failed frozen-shape validation: ${wire.error.issues
          .map((i) => i.message)
          .join('; ')}`,
      };
    }

    const options = resolveGateOptions(deps);
    const result = await invokeGate<CockpitGateOpenData>(
      { method: 'POST', path: '/cockpit/gates', body: wire.data },
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
    // The orchestrator ack is `{ accepted, retained }` (fire-and-forget; no
    // echoed gateId). Return the caller-facing `{ gateId, status }` using the
    // gateId the tool derived: `retained` (relay down → queued) vs `open`
    // (emitted to the cloud). Pass through any extra ack fields (retainQueue…).
    return {
      status: 'ok',
      data: {
        ...envelope.data,
        gateId,
        status: envelope.data.retained ? 'retained' : 'open',
      },
    };
  });
}
