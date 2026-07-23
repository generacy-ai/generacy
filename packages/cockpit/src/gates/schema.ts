import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Canonical cockpit gate wire schemas — the cluster (generacy) side of the
 * frozen contract in tetrad-development/docs/cockpit-remote-gates-plan.md
 * § "Wire contracts" and generacy-cloud/specs/843-part-cockpit-remote-gates/
 * contracts/gates-wire.md (Shapes 1/2/3).
 *
 * The cloud is the authoritative RECEIVER; these schemas MUST stay
 * field-for-field compatible with generacy-cloud:
 *   - services/api/src/services/relay/message-handler.ts
 *       gateOpenPayloadSchema / gateOutcomePayloadSchema
 *   - packages/db/src/collections/cockpit-gates.ts
 *       cockpitGateTypeEnum / cockpitGateOptionSchema / cockpitGateAnswerSchema
 *
 * Wire values are JSON, so all timestamps are ISO-8601 strings here; the cloud
 * ingests them with `z.coerce.date()`.
 */

// ---------------------------------------------------------------------------
// Gate type enum — mirrors cloud `cockpitGateTypeEnum` exactly (8 values, order preserved).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Option — mirrors cloud `cockpitGateOptionSchema`.
// ---------------------------------------------------------------------------
export const GateOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
});
export type GateOption = z.infer<typeof GateOptionSchema>;

// ---------------------------------------------------------------------------
// Shape 1 — gate-open (cluster → cloud, up-path).
// Mirrors cloud `gateOpenPayloadSchema` (message-handler.ts).
// Flat, type-literal 'gate-open'. gateId/gateKey are DERIVED by the MCP tool
// (cockpit_gate_open) — the plugin/LLM never hand-builds a sha256.
// ---------------------------------------------------------------------------
export const GateOpenSchema = z.object({
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
});
export type GateOpen = z.infer<typeof GateOpenSchema>;

// ---------------------------------------------------------------------------
// Shape 2 — gate-outcome (cluster → cloud, up-path). THE ACK.
// Replaces the invented GateAckSchema. Mirrors cloud `gateOutcomePayloadSchema`.
// ---------------------------------------------------------------------------
export const GateOutcomeSchema = z.object({
  type: z.literal('gate-outcome'),
  gateId: z.string().length(24),
  outcome: z.enum(['applied', 'superseded', 'failed']),
  detail: z.string().optional(),
  at: z.string().datetime(),
});
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;

// ---------------------------------------------------------------------------
// Shape 3 — gate-answer (cloud → cluster, down-path).
// Consumed by the orchestrator `POST /cockpit/answers` route + doorbell parser.
// Mirrors cloud stored `cockpitGateAnswerSchema` (nullable optionId/freeText and
// nullable actor.email/displayName) plus the wire-only type/gateId/gateKey.
// ---------------------------------------------------------------------------
export const GateAnswerSchema = z.object({
  type: z.literal('gate-answer'),
  gateId: z.string().length(24),
  gateKey: z.string().min(1),
  optionId: z.string().nullable(), // null on pure free-text
  freeText: z.string().nullable(),
  actor: z.object({
    userId: z.string(),
    email: z.string().email().nullable(),
    displayName: z.string().nullable(),
  }),
  answeredAt: z.string().datetime(),
  deliveryId: z.string(), // unique per delivery attempt; cluster dedups on this
});
export type GateAnswer = z.infer<typeof GateAnswerSchema>;

// ---------------------------------------------------------------------------
// Gate identity derivation.
//   gateKey = "<owner>/<repo>#<issue>:<gateType>:<generation>"
//           = `${issueRef}:${gateType}:${generation}`  (issueRef is owner/repo#N)
//   gateId  = sha256(gateKey) hex, first 24 chars.
// `generation` is gateType-specific (batch id, head SHA, phase number, drain
// counter, …); coerced to string so numeric discriminators (phase 2) are stable.
// ---------------------------------------------------------------------------
export function deriveGateKey(
  issueRef: string,
  gateType: GateType,
  generation: string | number,
): string {
  return `${issueRef}:${gateType}:${String(generation)}`;
}

export function deriveGateId(gateKey: string): string {
  return createHash('sha256').update(gateKey, 'utf8').digest('hex').slice(0, 24);
}
