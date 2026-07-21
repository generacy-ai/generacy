/**
 * Local Zod schemas for the two remote-gate MCP tools (#1022).
 *
 * Wire contracts (`GateRecord` shape, `gateId`/`generation` rules,
 * `status`/`outcome` enums, NDJSON answer line) are owned by the epic:
 *   contracts/cockpit_gate_open.md
 *   docs/cockpit-remote-gates-plan.md (agency-repo epic doc)
 *
 * The schemas below are LOCAL MIRRORS for input validation and response
 * typing. `.passthrough()` on the record shape means unknown caller fields
 * are forwarded to the orchestrator verbatim — contract drift on the epic
 * side never causes a local schema-strip bug.
 *
 * Data-model reference: specs/1022-part-cockpit-remote-gates/data-model.md
 * § "Core types" and § "MCP-boundary schemas".
 */
import { z } from 'zod';

/**
 * Caller-supplied gate record. Local schema is a passthrough object so the
 * orchestrator remains the sole authority on `GateRecord` shape.
 */
export const GateRecordSchema = z
  .record(z.unknown())
  .and(z.object({}).passthrough());
export type GateRecord = z.infer<typeof GateRecordSchema>;

/**
 * Strict three-field ack input. `.strict()` catches typos (`gate_id` vs
 * `gateId`) at the tool boundary with a clear `invalid-args` error.
 */
export const GateAckInputSchema = z
  .object({
    gateId: z.string().min(1),
    outcome: z.string().min(1),
    detail: z.string().optional(),
  })
  .strict();
export type GateAckInput = z.infer<typeof GateAckInputSchema>;

/**
 * Orchestrator response envelope for `POST /cockpit/gates`. Asserts the two
 * fields the tool contract promises callers; additional fields (e.g.
 * `coalescedWith`, `inboxUrl`) pass through opaquely.
 */
export const GateOpenResponseSchema = z
  .object({ gateId: z.string(), status: z.string() })
  .passthrough();
export type GateOpenResponse = z.infer<typeof GateOpenResponseSchema>;

/**
 * Opaque response envelope for `POST /cockpit/gates/:id/ack`. The body shape
 * is not asserted at this boundary — whatever JSON the orchestrator returns
 * is forwarded verbatim inside `ToolOkResult.data`.
 */
export const GateAckResponseSchema = z.record(z.unknown());
export type GateAckResponse = z.infer<typeof GateAckResponseSchema>;
