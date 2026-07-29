/**
 * Local Zod mirrors for the two remote-gate MCP tools (#1022 / #843).
 *
 * These are the CLUSTER-side (generacy) mirror of the frozen wire contract in
 * tetrad-development/docs/cockpit-remote-gates-plan.md § "Wire contracts" and
 * generacy-cloud/specs/843-part-cockpit-remote-gates/contracts/gates-wire.md
 * (Shapes 1 & 2). The cloud is the authoritative RECEIVER; these mirrors MUST
 * stay field-for-field compatible with it.
 *
 * DESIGN (approved): `cockpit_gate_open` DERIVES gateKey + gateId in TypeScript
 * from (issueRef, gateType, generation-discriminator). The plugin/LLM NEVER
 * hand-builds a sha256 or the gateKey string — it passes semantic + presentation
 * fields only, and the tool assembles the flat frozen record and sets
 * type:'gate-open'. `cockpit_gate_ack` emits a gate-outcome record (Shape 2,
 * THE ACK) — NOT the old invented gate-ack.
 *
 * The derivation helpers are duplicated here (rather than imported from
 * `@generacy-ai/cockpit`) so the MCP boundary stays insulated from cross-package
 * export churn — the same insulation rationale as the prior passthrough mirror,
 * and it keeps the tool's input a FLAT `z.object` (the MCP `inputSchema` needs a
 * `.shape`; the prior `z.record().and()` intersection had none — gen#1032/#1033).
 *
 * Data-model reference: specs/1022-part-cockpit-remote-gates/data-model.md
 * § "Core types" and § "MCP-boundary schemas".
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums — mirror the cloud `cockpitGateTypeEnum` / gate-outcome enum exactly.
// ---------------------------------------------------------------------------

/** 8-value gate-type enum (order preserved to match the cloud enum). */
export const GateTypeSchema = z.enum([
  'clarification',
  'artifact-review',
  'implementation-review',
  'manual-validation',
  'escalation',
  'phase-queue',
  'filing',
  'scope-drained',
]);
export type GateType = z.infer<typeof GateTypeSchema>;

/** Closed gate-outcome enum (replaces the old free-string outcome). */
export const GateOutcomeSchema = z.enum(['applied', 'superseded', 'failed']);
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;

/** Presentation option — mirrors cloud `cockpitGateOptionSchema`. */
export const GateOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
});
export type GateOption = z.infer<typeof GateOptionSchema>;

// ---------------------------------------------------------------------------
// Gate identity derivation (frozen contract).
//   gateKey = `${issueRef}:${gateType}:${generation}[:${runId}]`
//   gateId  = sha256(gateKey) hex, first 24 chars.
// `generation` is the gateType-specific discriminator (batch id, head SHA,
// phase number, draft hash, occurrence counter, drain counter, …); coerced to
// a string so numeric discriminators (phase 2) are stable.
// `runId` (#1053) is the optional per-run discriminator that guarantees a
// fresh gateId across independent runs of the same natural gate. When absent
// the output is byte-for-byte compatible with the pre-#1053 shape. Signature
// mirrors the canonical `@generacy-ai/cockpit` derivation.
// ---------------------------------------------------------------------------
export function deriveGateKey(
  issueRef: string,
  gateType: GateType,
  generation: string | number,
  runId?: string,
): string {
  const base = `${issueRef}:${gateType}:${String(generation)}`;
  return runId === undefined ? base : `${base}:${runId}`;
}

export function deriveGateId(gateKey: string): string {
  return createHash('sha256').update(gateKey, 'utf8').digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------------------
// `cockpit_gate_open` — SEMANTIC input (what the plugin passes).
// The tool derives gateKey/gateId and assembles the frozen record. `.strict()`
// surfaces caller typos at the MCP boundary as `invalid-args`.
// ---------------------------------------------------------------------------
export const GateOpenInputSchema = z
  .object({
    /** owner/repo#N (for G.5 the epic ref; for G.6/G.7 the tracking/filing target). */
    issueRef: z.string().min(1),
    gateType: GateTypeSchema,
    /** gateType-specific discriminator (batch id / head SHA / phase number / …). */
    generation: z.union([z.string().min(1), z.number()]),
    epicRef: z.string().min(1),
    issueTitle: z.string(),
    /** Fully-qualified https issue URL — the cloud pins z.string().url(). */
    issueUrl: z.string().url(),
    branch: z.string().min(1).optional(),
    prNumber: z.number().int().positive().optional(),
    title: z.string(),
    body: z.string(),
    options: z.array(GateOptionSchema).min(0).max(20).default([]),
    /** Every gate keeps an "Other"-style escape hatch; defaults to true. */
    allowFreeText: z.boolean().default(true),
    sessionId: z.string().min(1),
    /** ISO-8601; defaulted to now() by the tool when omitted. */
    askedAt: z.string().datetime().optional(),
    /**
     * Optional per-run discriminator (#1053). When passed, folded into `gateKey`
     * as a trailing `:${runId}` segment so re-runs against the same natural
     * gate produce a fresh `gateId`.
     *
     * When OMITTED there is NO run discrimination at all: `deriveGateKey`
     * returns the legacy 3-tuple `issueRef:gateType:generation`, byte-identical
     * to pre-#1053 behaviour, so a re-run against a gate that already reached a
     * terminal status still collides and is dropped by the cloud. Callers MUST
     * pass `runId` to get the #1053 fix.
     *
     * An earlier draft minted a per-process `INSTANCE_NONCE` fallback here.
     * That was rejected on review: process lifetime is not run lifetime, so it
     * both failed to discriminate two runs in one MCP process and flipped
     * mid-run on a server restart. Do not reintroduce it.
     *
     * Threading `runId` from callers is tracked in #1059 — note it must land
     * together with the read-side changes there, or `cockpit_gate_status`
     * silently returns `absent` for every gate.
     */
    runId: z.string().min(1).optional(),
  })
  .strict();
export type GateOpenInput = z.infer<typeof GateOpenInputSchema>;

/**
 * Frozen gate-open wire record (Shape 1) — the flat record the tool forwards to
 * the orchestrator, which relays it verbatim to the cloud. Field-for-field
 * mirror of cloud `gateOpenPayloadSchema` (message-handler.ts). The tool
 * self-validates its assembled record against this before it leaves the cluster.
 */
export const GateOpenWireSchema = z.object({
  type: z.literal('gate-open'),
  gateId: z.string().length(24),
  gateKey: z.string().min(1),
  gateType: GateTypeSchema,
  epicRef: z.string().min(1),
  issueRef: z.string().min(1),
  issueTitle: z.string(),
  issueUrl: z.string().url(),
  branch: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  title: z.string(),
  body: z.string(),
  options: z.array(GateOptionSchema).min(0).max(20),
  allowFreeText: z.boolean(),
  sessionId: z.string().min(1),
  askedAt: z.string().datetime(),
  // #1077 — optional per-frame correlation id preserved on the tool self-check
  // so callers that hand-supply one can pass the outbound `safeParse` without
  // shape drift. The route mints one when this is absent.
  frameId: z.string().min(1).optional(),
});
export type GateOpenWire = z.infer<typeof GateOpenWireSchema>;

// ---------------------------------------------------------------------------
// `cockpit_gate_ack` — SEMANTIC input + frozen gate-outcome wire record.
// ---------------------------------------------------------------------------

/**
 * Strict ack input. `outcome` is the closed frozen enum (NOT a free string);
 * `at` defaults to now() in the tool when omitted. `.strict()` catches typos
 * (`gate_id`, `ackedAt`, a stray `generation`, …) at the boundary.
 */
export const GateAckInputSchema = z
  .object({
    gateId: z.string().length(24),
    outcome: GateOutcomeSchema,
    detail: z.string().optional(),
    at: z.string().datetime().optional(),
    /**
     * Optional per-run discriminator (#1053). Accepted-and-ignored on the ack
     * path — no derivation happens here (the ack targets an existing gateId).
     * Present so auto-loop callers can pass the same envelope shape to both
     * `cockpit_gate_open` and `cockpit_gate_ack` without tripping `.strict()`.
     */
    runId: z.string().min(1).optional(),
  })
  .strict();
export type GateAckInput = z.infer<typeof GateAckInputSchema>;

/**
 * Frozen gate-outcome wire record (Shape 2, THE ACK) — mirror of cloud
 * `gateOutcomePayloadSchema`. Replaces the invented gate-ack: `type` (not
 * `kind`), `at` (not `ackedAt`), closed `outcome` enum, and NO `generation`.
 */
export const GateOutcomeWireSchema = z.object({
  type: z.literal('gate-outcome'),
  gateId: z.string().length(24),
  outcome: GateOutcomeSchema,
  detail: z.string().optional(),
  at: z.string().datetime(),
  // #1077 — see GateOpenWireSchema.frameId. Same shape and rationale.
  frameId: z.string().min(1).optional(),
});
export type GateOutcomeWire = z.infer<typeof GateOutcomeWireSchema>;

// ---------------------------------------------------------------------------
// Orchestrator response envelopes.
// ---------------------------------------------------------------------------

/**
 * Response envelope for `POST /cockpit/gates`. The orchestrator route is
 * fire-and-forget: it validates the frozen gate-open, EMITS it on the
 * `cluster.cockpit` relay channel (or retains it when the relay is down), and
 * replies `202 { accepted, retained, retainQueue? }` — it does NOT echo a
 * `gateId` (the cluster already knows it; the inbox URL is assigned cloud-side,
 * asynchronously). The tool maps this ack to the caller-facing `{ gateId, status }`
 * using the `gateId` IT derived. Extra fields (`retainQueue`, …) pass through.
 */
export const GateOpenResponseSchema = z
  .object({ accepted: z.boolean(), retained: z.boolean() })
  .passthrough();
export type GateOpenResponse = z.infer<typeof GateOpenResponseSchema>;

/**
 * Opaque response envelope for `POST /cockpit/gates/:id/ack`. The body shape is
 * not asserted at this boundary — whatever JSON the orchestrator returns is
 * forwarded verbatim inside `ToolOkResult.data`.
 */
export const GateAckResponseSchema = z.record(z.unknown());
export type GateAckResponse = z.infer<typeof GateAckResponseSchema>;
