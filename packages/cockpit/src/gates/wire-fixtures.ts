/**
 * Wire-envelope fixture builders for the cluster-side transport contracts
 * (#1024). These build the exact JSON frames that cross the cluster-side wire,
 * all validated against the canonical schemas in `./schema.ts`:
 *
 *   - `gateOpenFixture()`    → body of `POST /cockpit/gates`        (`GateOpenSchema`, Shape 1)
 *   - `gateOutcomeFixture()` → body of `POST /cockpit/gates/:id/ack` (`GateOutcomeSchema`, Shape 2 — THE ACK)
 *   - `answerLineFixture()`  → body of `POST /cockpit/answers` AND the NDJSON
 *                              line the doorbell tails               (`GateAnswerSchema`, Shape 3)
 *
 * The #1024 integration harness single-sources every wire body through these
 * builders (FR-009 / SC-004) so a drift in the transport shape fails the
 * harness in one place rather than silently passing an inline literal.
 *
 * NB: the frozen frames are FLAT with a `type` discriminator ('gate-open' |
 * 'gate-outcome' | 'gate-answer'); there is no `kind`, no `scope` wrapper and no
 * top-level `generation` (generation is folded into `gateKey`). gateId/gateKey
 * are DERIVED, so the default frame carries a real 24-hex gateId.
 */
import {
  GateAnswerSchema,
  GateOpenSchema,
  GateOutcomeSchema,
  deriveGateId,
  deriveGateKey,
  type GateAnswer,
  type GateOpen,
  type GateOutcome,
} from './schema.js';
import { issueRefToString, type IssueRef } from './schemas.js';

/** Epic/issue scope the harness binds the doorbell to. The wire carries the ref
 *  as the flat `owner/repo#N` string ({@link DEFAULT_WIRE_EPIC_REF}); this object
 *  form is a convenience for callers that need the parts. */
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
export const DEFAULT_WIRE_EPIC_REF = issueRefToString(DEFAULT_WIRE_SCOPE as IssueRef);

const DEFAULT_GATE_TYPE = 'phase-queue' as const;
const DEFAULT_GENERATION = '2';
const DEFAULT_GATE_KEY = deriveGateKey(DEFAULT_WIRE_EPIC_REF, DEFAULT_GATE_TYPE, DEFAULT_GENERATION);
const DEFAULT_GATE_ID = deriveGateId(DEFAULT_GATE_KEY);
const DEFAULT_SESSION_ID = 'sess-1024-default';
const DEFAULT_ASKED_AT = '2026-07-21T12:00:00.000Z';
const DEFAULT_ANSWERED_AT = '2026-07-21T12:05:00.000Z';
const DEFAULT_OUTCOME_AT = '2026-07-21T12:05:01.000Z';

const DEFAULT_ACTOR = {
  userId: 'user-1024',
  email: 'operator@example.com',
  displayName: 'Operator One',
} as const;

export interface GateOpenFixtureOverrides {
  gateId?: string;
  gateKey?: string;
  gateType?: GateOpen['gateType'];
  epicRef?: string;
  issueRef?: string;
  issueTitle?: string;
  issueUrl?: string;
  title?: string;
  body?: string;
  options?: GateOpen['options'];
  allowFreeText?: boolean;
  sessionId?: string;
  askedAt?: string;
}

/**
 * Build a `POST /cockpit/gates` body (Shape 1). Validated against
 * `GateOpenSchema` before return so a builder that drifts from the transport
 * contract throws at the call site.
 */
export function gateOpenFixture(overrides: GateOpenFixtureOverrides = {}): GateOpen {
  const body = {
    type: 'gate-open' as const,
    gateId: overrides.gateId ?? DEFAULT_GATE_ID,
    gateKey: overrides.gateKey ?? DEFAULT_GATE_KEY,
    gateType: overrides.gateType ?? DEFAULT_GATE_TYPE,
    epicRef: overrides.epicRef ?? DEFAULT_WIRE_EPIC_REF,
    issueRef: overrides.issueRef ?? DEFAULT_WIRE_EPIC_REF,
    issueTitle: overrides.issueTitle ?? 'Phase 2: cockpit remote gates',
    issueUrl:
      overrides.issueUrl ??
      `https://github.com/${DEFAULT_WIRE_SCOPE.owner}/${DEFAULT_WIRE_SCOPE.repo}/issues/${DEFAULT_WIRE_SCOPE.number}`,
    title: overrides.title ?? 'Queue phase 2?',
    body: overrides.body ?? 'Proceed with the next phase?',
    options: overrides.options ?? [
      { id: 'proceed', label: 'Proceed', recommended: true },
      { id: 'hold', label: 'Hold' },
    ],
    allowFreeText: overrides.allowFreeText ?? true,
    sessionId: overrides.sessionId ?? DEFAULT_SESSION_ID,
    askedAt: overrides.askedAt ?? DEFAULT_ASKED_AT,
  };
  return GateOpenSchema.parse(body);
}

export interface GateOutcomeFixtureOverrides {
  gateId?: string;
  outcome?: GateOutcome['outcome'];
  detail?: string;
  at?: string;
}

/**
 * Build a `POST /cockpit/gates/:id/ack` body (Shape 2, the gate-outcome ACK).
 * The route injects the path `:id` as `gateId`; the fixture carries a matching
 * `gateId` so a direct POST with `body.gateId === :id` passes any equality guard.
 */
export function gateOutcomeFixture(overrides: GateOutcomeFixtureOverrides = {}): GateOutcome {
  const body = {
    type: 'gate-outcome' as const,
    gateId: overrides.gateId ?? DEFAULT_GATE_ID,
    outcome: overrides.outcome ?? 'applied',
    ...(overrides.detail !== undefined ? { detail: overrides.detail } : {}),
    at: overrides.at ?? DEFAULT_OUTCOME_AT,
  };
  return GateOutcomeSchema.parse(body);
}

export interface AnswerLineFixtureOverrides {
  deliveryId?: string;
  gateId?: string;
  gateKey?: string;
  optionId?: string | null;
  freeText?: string | null;
  actor?: GateAnswer['actor'];
  answeredAt?: string;
}

/**
 * Build a gate-answer line (Shape 3, down-path). This is the single wire shape
 * that flows peer/cloud → `POST /cockpit/answers` → answers file → doorbell
 * tail (FR-005) — the seam the #1024 harness exists to pin. Validated against
 * `GateAnswerSchema`.
 */
export function answerLineFixture(overrides: AnswerLineFixtureOverrides = {}): GateAnswer {
  const body = {
    type: 'gate-answer' as const,
    gateId: overrides.gateId ?? DEFAULT_GATE_ID,
    gateKey: overrides.gateKey ?? DEFAULT_GATE_KEY,
    optionId: overrides.optionId !== undefined ? overrides.optionId : 'proceed',
    freeText: overrides.freeText !== undefined ? overrides.freeText : null,
    actor: overrides.actor ?? { ...DEFAULT_ACTOR },
    answeredAt: overrides.answeredAt ?? DEFAULT_ANSWERED_AT,
    deliveryId: overrides.deliveryId ?? 'dlv_1024_default',
  };
  return GateAnswerSchema.parse(body);
}
