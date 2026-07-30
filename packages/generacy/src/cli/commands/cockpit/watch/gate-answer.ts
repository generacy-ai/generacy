/**
 * `gate-answer` — the `CockpitStreamEvent` variant + wire schema for operator
 * gate answers tailed from `/workspaces/.generacy/cockpit/answers.ndjson`.
 *
 * The NDJSON line is the FROZEN down-path Shape 3 (cloud → cluster). See
 * `tetrad-development/docs/cockpit-remote-gates-plan.md` § "Wire contracts" and
 * `generacy-cloud/specs/843-part-cockpit-remote-gates/contracts/gates-wire.md`.
 * The cloud is the authoritative SENDER; this schema must stay field-compatible
 * with what `services/api/src/services/cockpit-gate-delivery.ts` POSTs to
 * `POST /cockpit/answers` (the orchestrator route appends it verbatim).
 *
 * Frozen shape (flat — NOT the old `kind`/`scope`/nested-`answer`/`generation`
 * envelope):
 *   { type:'gate-answer', gateId, gateKey, optionId(string|null),
 *     freeText(string|null), actor:{userId,email(string|null),
 *     displayName(string|null)}, answeredAt(ISO), deliveryId }
 *
 * Nullability mirrors the cloud stored answer exactly: the cloud sends
 * `freeText:null` explicitly on option-only answers, and `actor.email` /
 * `actor.displayName` may be null for anonymous / partial-profile actors — so
 * the parser must NOT tighten these to non-null / required, or a legitimate
 * delivery is dropped as "malformed".
 *
 * `gateId` is pinned only `min(1)` here (not `length(24)`): the orchestrator
 * `POST /cockpit/answers` route already validates the full frozen
 * `GateAnswerSchema` (24-char hex) before appending, so the tailer treats the
 * gateId as an opaque identity string it hoists + logs. The reconciliation this
 * schema fixes is the STRUCTURE (kind→type, scope→gateKey, nested-answer→flat
 * optionId/freeText/actor), which IS pinned strictly below.
 */
import { z } from 'zod';

/** Down-path actor. `email`/`displayName` nullable — see cloud stored answer. */
export const GateAnswerActorSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email().nullable(),
  displayName: z.string().nullable(),
});
export type GateAnswerActor = z.infer<typeof GateAnswerActorSchema>;

export const GateAnswerLineSchema = z
  .object({
    type: z.literal('gate-answer'),
    gateId: z.string().min(1),
    gateKey: z.string().min(1),
    optionId: z.string().nullable(), // null on a pure free-text answer
    freeText: z.string().nullable(), // present-and-null on an option-only answer
    actor: GateAnswerActorSchema,
    answeredAt: z.string().datetime(),
    deliveryId: z.string().min(1), // unique per delivery attempt; session dedups on this
  })
  .passthrough();

export type GateAnswerLine = z.infer<typeof GateAnswerLineSchema>;

export const GateAnswerEventSchema = z.object({
  type: z.literal('gate-answer'),
  ts: z.string().datetime(),
  gateId: z.string().min(1),
  deliveryId: z.string().min(1),
  epic: z.string().regex(/^[^/]+\/[^/]+#\d+$/),
  line: GateAnswerLineSchema,
});

export type GateAnswerEvent = z.infer<typeof GateAnswerEventSchema>;
