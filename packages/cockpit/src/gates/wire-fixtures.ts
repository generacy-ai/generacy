/**
 * Wire-envelope fixture builders for the cluster-side transport contracts
 * (#1024). These are distinct from the operator-inbox record fixtures in
 * `fixtures.ts` (`VALID_FIXTURES` etc.): the records describe the rich gate
 * shown in the cloud inbox, whereas the *envelopes* here are the exact bytes
 * that cross the cluster-side wire —
 *
 *   - `gateOpenFixture()`   → body of `POST /cockpit/gates`   (`GateOpenSchema`)
 *   - `gateAckFixture()`    → body of `POST /cockpit/gates/:id/ack` (`GateAckSchema`)
 *   - `answerLineFixture()` → body of `POST /cockpit/answers` AND the NDJSON
 *                             line the doorbell tails (`GateAnswerEnvelopeSchema`
 *                             on the route + `GateAnswerLineSchema` in the
 *                             doorbell — the returned object satisfies both).
 *
 * The #1024 integration harness single-sources every wire body through these
 * builders (FR-009 / SC-004) so a drift in the transport shape fails the
 * harness in one place rather than silently passing an inline literal.
 *
 * See `specs/1024-part-cockpit-remote-gates/contracts/fake-peer-protocol.md`
 * and the `packages/cockpit/src/gates/README.md` wire-shape table.
 */
import {
  GateOpenSchema,
  GateAckSchema,
  GateAnswerEnvelopeSchema,
  type GateOpen,
  type GateAck,
  type GateAnswerEnvelope,
} from './schema.js';

/** Epic/issue scope carried on gate-open and answer envelopes. The doorbell's
 *  `GateAnswerLineSchema` requires `{ owner, repo, number }` on the answer
 *  line, so the default scope here matches that shape and the harness's bound
 *  epic ref (`generacy-ai/generacy#1024`). */
export interface WireScope {
  owner: string;
  repo: string;
  number: number;
}

export const DEFAULT_WIRE_SCOPE: WireScope = {
  owner: 'generacy-ai',
  repo: 'generacy',
  number: 1024,
};

/** `owner/repo#number` for the default scope — the epic ref the harness binds
 *  the doorbell to. Kept in lockstep with {@link DEFAULT_WIRE_SCOPE}. */
export const DEFAULT_WIRE_EPIC_REF = `${DEFAULT_WIRE_SCOPE.owner}/${DEFAULT_WIRE_SCOPE.repo}#${DEFAULT_WIRE_SCOPE.number}`;

const DEFAULT_GATE_ID = 'g_1024_default';
const DEFAULT_OPENED_AT = '2026-07-21T12:00:00.000Z';
const DEFAULT_ANSWERED_AT = '2026-07-21T12:05:00.000Z';
const DEFAULT_ACKED_AT = '2026-07-21T12:05:01.000Z';

export interface GateOpenFixtureOverrides {
  gateId?: string;
  generation?: number;
  scope?: WireScope;
  openedAt?: string;
  payload?: unknown;
}

/**
 * Build a `POST /cockpit/gates` body. Validated against `GateOpenSchema` before
 * return so a builder that drifts from the transport contract throws at the
 * call site (the SC-003 breakage surface for the #1020 contracts sibling).
 */
export function gateOpenFixture(overrides: GateOpenFixtureOverrides = {}): GateOpen {
  const body = {
    kind: 'gate-open' as const,
    gateId: overrides.gateId ?? DEFAULT_GATE_ID,
    generation: overrides.generation ?? 0,
    scope: overrides.scope ?? { ...DEFAULT_WIRE_SCOPE },
    openedAt: overrides.openedAt ?? DEFAULT_OPENED_AT,
    payload: overrides.payload ?? { question: 'Proceed with the phase?' },
  };
  return GateOpenSchema.parse(body);
}

export interface GateAckFixtureOverrides {
  gateId?: string;
  generation?: number;
  outcome?: string;
  ackedAt?: string;
  answer?: unknown;
}

/**
 * Build a `POST /cockpit/gates/:id/ack` body. The route also injects the path
 * `:id` as `gateId`; the fixture carries a matching `gateId` so a direct POST
 * with `body.gateId === :id` passes the route's equality guard.
 */
export function gateAckFixture(overrides: GateAckFixtureOverrides = {}): GateAck {
  const body = {
    kind: 'gate-ack' as const,
    gateId: overrides.gateId ?? DEFAULT_GATE_ID,
    generation: overrides.generation ?? 0,
    outcome: overrides.outcome ?? 'answered',
    ackedAt: overrides.ackedAt ?? DEFAULT_ACKED_AT,
    answer: overrides.answer ?? { choice: 'proceed' },
  };
  return GateAckSchema.parse(body);
}

export interface AnswerLineFixtureOverrides {
  deliveryId?: string;
  gateId?: string;
  generation?: number;
  scope?: WireScope;
  answeredAt?: string;
  answeredBy?: string;
  answer?: unknown;
}

/**
 * Build a gate-answer line. The returned object satisfies BOTH the orchestrator
 * route schema (`GateAnswerEnvelopeSchema`) and the doorbell tail schema
 * (`GateAnswerLineSchema`): it carries `kind`/`generation`/`answeredAt` for the
 * envelope and `scope`/`answeredBy` for the line. This is the single wire shape
 * that flows peer → `POST /cockpit/answers` → answers file → doorbell tail
 * (FR-005) — the seam the #1024 harness exists to pin.
 */
export function answerLineFixture(
  overrides: AnswerLineFixtureOverrides = {},
): GateAnswerEnvelope & { scope: WireScope; answeredBy: string } {
  const body = {
    kind: 'gate-answer' as const,
    deliveryId: overrides.deliveryId ?? 'dlv_1024_default',
    gateId: overrides.gateId ?? DEFAULT_GATE_ID,
    generation: overrides.generation ?? 0,
    answeredAt: overrides.answeredAt ?? DEFAULT_ANSWERED_AT,
    scope: overrides.scope ?? { ...DEFAULT_WIRE_SCOPE },
    answeredBy: overrides.answeredBy ?? 'operator@example.com',
    answer: overrides.answer ?? { choice: 'proceed' },
  };
  // Validate against the transport (route) schema. The additional `scope` and
  // `answeredBy` keys survive `.passthrough()` and satisfy the doorbell's
  // `GateAnswerLineSchema` at runtime.
  GateAnswerEnvelopeSchema.parse(body);
  return body;
}
