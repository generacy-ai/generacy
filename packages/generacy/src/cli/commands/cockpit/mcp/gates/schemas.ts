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
 * Caller-supplied gate record. MUST be a flat `z.object({...}).passthrough()`
 * — NOT a `z.record().and(...)` intersection.
 *
 * An intersection has no `.shape`, so the MCP SDK advertised an EMPTY input
 * schema for `cockpit_gate_open`. With no declared property types, the tool-
 * call boundary stringified the typed `generation` (number) and `scope`
 * (object) fields, and the orchestrator's authoritative `GateOpenSchema`
 * rejected the envelope as `invalid-args`. Enumerating the fields with their
 * true types makes the SDK advertise a real schema so the harness sends
 * numbers as numbers and objects as objects.
 *
 * Field types mirror `@generacy-ai/cockpit`'s `GateOpenSchema` (the sole
 * authority the orchestrator validates against) but stay intentionally more
 * lenient — `kind` is a plain string (not the `'gate-open'` literal),
 * `openedAt` is a plain string (not `.datetime()`) — so this boundary never
 * rejects an envelope the orchestrator would accept. `.passthrough()` still
 * forwards unknown fields verbatim, keeping the orchestrator the sole
 * authority on the full `GateRecord` shape.
 */
export const GateRecordSchema = z
  .object({
    kind: z.string().optional(),
    gateId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    scope: z.object({}).passthrough(),
    openedAt: z.string(),
  })
  .passthrough();
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
