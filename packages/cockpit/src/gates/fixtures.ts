import {
  GateAnswerSchema,
  GateOpenSchema,
  GateOutcomeSchema,
  deriveGateId,
  deriveGateKey,
  type GateAnswer,
  type GateOpen,
  type GateOutcome,
  type GateType,
} from './schema.js';
import { issueRefToString, type IssueRef } from './schemas.js';
import {
  deriveArtifactReviewGeneration,
  deriveClarificationGeneration,
  deriveEscalationGeneration,
  deriveFilingGeneration,
  deriveImplementationReviewGeneration,
  deriveManualValidationGeneration,
  derivePhaseQueueGeneration,
  deriveScopeDrainedGeneration,
} from './generation.js';

const EPIC_REF: IssueRef = { owner: 'generacy-ai', repo: 'generacy', number: 1000 };
const ISSUE_REF: IssueRef = { owner: 'generacy-ai', repo: 'generacy', number: 1020 };
const TRACKING_REF: IssueRef = { owner: 'generacy-ai', repo: 'generacy', number: 900 };
const EPIC_REF_STR = issueRefToString(EPIC_REF);
const ISSUE_REF_STR = issueRefToString(ISSUE_REF);
const SESSION_ID = 'sess-abc123def456';
const ASKED_AT = '2026-07-21T12:00:00.000Z';
const ANSWERED_AT = '2026-07-21T12:05:00.000Z';
const OUTCOME_AT = '2026-07-21T12:05:01.000Z';

const ACTOR = {
  userId: 'user-1',
  email: 'operator@example.com',
  displayName: 'Operator One',
} as const;

const DEFAULT_OPTIONS = [
  { id: 'opt-a', label: 'Approve', description: 'Approve and proceed' },
  { id: 'opt-b', label: 'Reject', description: 'Reject and halt', recommended: true },
] as const;

const GENERATIONS: Record<GateType, string> = {
  clarification: deriveClarificationGeneration({
    questions: [{ questionNumber: 1, questionText: 'Which transport should we use?' }],
  }),
  'artifact-review': deriveArtifactReviewGeneration({ kind: 'spec-review', headSha: 'abc1234' }),
  'implementation-review': deriveImplementationReviewGeneration({ headSha: 'def5678' }),
  'manual-validation': deriveManualValidationGeneration({ phaseNumber: 2 }),
  escalation: deriveEscalationGeneration({
    subtype: 'stalled',
    labelOrState: 'agent:error',
    counter: 1,
  }),
  'phase-queue': derivePhaseQueueGeneration({ phaseNumber: 3 }),
  filing: deriveFilingGeneration({ draftHash: 'feedbeef1234' }),
  'scope-drained': deriveScopeDrainedGeneration({ trackingIssueRef: TRACKING_REF, counter: 1 }),
};

// phase-queue is the sole per-issue exception: its wire `issueRef` slot carries
// the EPIC ref, not a child issue (see the auto.md UI-mode gate-mapping table).
function issueRefFor(gateType: GateType): string {
  return gateType === 'phase-queue' ? EPIC_REF_STR : ISSUE_REF_STR;
}

function buildRecord(gateType: GateType): GateOpen {
  const generation = GENERATIONS[gateType];
  const issueRef = issueRefFor(gateType);
  const gateKey = deriveGateKey(issueRef, gateType, generation);
  const gateId = deriveGateId(gateKey);
  return {
    type: 'gate-open',
    gateId,
    gateKey,
    gateType,
    epicRef: EPIC_REF_STR,
    issueRef,
    issueTitle: `Issue #${ISSUE_REF.number}: cockpit remote gates`,
    issueUrl: `https://github.com/${ISSUE_REF.owner}/${ISSUE_REF.repo}/issues/${ISSUE_REF.number}`,
    title: `${gateType} gate`,
    body: `Please review the ${gateType} gate.`,
    options: DEFAULT_OPTIONS.map((o) => ({ ...o })),
    allowFreeText: true,
    sessionId: SESSION_ID,
    askedAt: ASKED_AT,
  };
}

export const VALID_FIXTURES: Record<GateType, GateOpen> = {
  clarification: buildRecord('clarification'),
  'artifact-review': buildRecord('artifact-review'),
  'implementation-review': buildRecord('implementation-review'),
  'manual-validation': buildRecord('manual-validation'),
  escalation: buildRecord('escalation'),
  'phase-queue': buildRecord('phase-queue'),
  filing: buildRecord('filing'),
  'scope-drained': buildRecord('scope-drained'),
};

// Assert every valid fixture parses at module load — fixture drift fails the build,
// not a test run.
for (const gateType of Object.keys(VALID_FIXTURES) as GateType[]) {
  GateOpenSchema.parse(VALID_FIXTURES[gateType]);
}

interface AnswerSpec {
  optionId: string | null;
  freeText: string | null;
}

// optionId XOR free-text is NOT enforced on the wire (the cloud sends the unused
// side as an explicit null); every fixture therefore carries both fields.
const ANSWER_SPECS: Record<GateType, AnswerSpec> = {
  clarification: { optionId: 'opt-a', freeText: null },
  'artifact-review': { optionId: null, freeText: 'approve with concerns' },
  'implementation-review': { optionId: 'opt-a', freeText: null },
  'manual-validation': { optionId: null, freeText: 'verified manually on 2026-07-21' },
  escalation: { optionId: 'opt-a', freeText: null },
  'phase-queue': { optionId: null, freeText: 'proceed with next phase' },
  filing: { optionId: 'opt-a', freeText: null },
  'scope-drained': { optionId: null, freeText: 'confirmed scope drained' },
};

function buildAnswer(gateType: GateType): GateAnswer {
  const record = VALID_FIXTURES[gateType];
  const spec = ANSWER_SPECS[gateType];
  return {
    type: 'gate-answer',
    gateId: record.gateId,
    gateKey: record.gateKey,
    optionId: spec.optionId,
    freeText: spec.freeText,
    actor: { ...ACTOR },
    answeredAt: ANSWERED_AT,
    deliveryId: `delivery-${gateType}-1`,
  };
}

export const VALID_ANSWER_FIXTURES: Record<GateType, GateAnswer> = {
  clarification: buildAnswer('clarification'),
  'artifact-review': buildAnswer('artifact-review'),
  'implementation-review': buildAnswer('implementation-review'),
  'manual-validation': buildAnswer('manual-validation'),
  escalation: buildAnswer('escalation'),
  'phase-queue': buildAnswer('phase-queue'),
  filing: buildAnswer('filing'),
  'scope-drained': buildAnswer('scope-drained'),
};

for (const gateType of Object.keys(VALID_ANSWER_FIXTURES) as GateType[]) {
  GateAnswerSchema.parse(VALID_ANSWER_FIXTURES[gateType]);
}

// gate-outcome (the ACK) fixtures — one per closed outcome enum value.
export const VALID_ACK_FIXTURES: Record<'applied' | 'superseded' | 'failed', GateOutcome> = {
  applied: {
    type: 'gate-outcome',
    gateId: VALID_FIXTURES.clarification.gateId,
    outcome: 'applied',
    at: OUTCOME_AT,
  },
  superseded: {
    type: 'gate-outcome',
    gateId: VALID_FIXTURES['artifact-review'].gateId,
    outcome: 'superseded',
    detail: 'A newer answer arrived first',
    at: OUTCOME_AT,
  },
  failed: {
    type: 'gate-outcome',
    gateId: VALID_FIXTURES.escalation.gateId,
    outcome: 'failed',
    detail: 'Label mutation returned 422',
    at: OUTCOME_AT,
  },
};

for (const key of Object.keys(VALID_ACK_FIXTURES) as Array<keyof typeof VALID_ACK_FIXTURES>) {
  GateOutcomeSchema.parse(VALID_ACK_FIXTURES[key]);
}

const BASE_RECORD_UNKNOWN = VALID_FIXTURES.clarification as unknown as Record<string, unknown>;
const BASE_ANSWER_UNKNOWN = VALID_ANSWER_FIXTURES.clarification as unknown as Record<
  string,
  unknown
>;

function withoutKey<T extends Record<string, unknown>>(
  obj: T,
  key: string,
): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...obj };
  delete clone[key];
  return clone;
}

export const MALFORMED_FIXTURES: Record<string, unknown> = {
  // Wrong up-path discriminator (must be the 'gate-open' literal).
  'wrong-type-literal': {
    ...BASE_RECORD_UNKNOWN,
    type: 'gate-ack',
  },
  // Option missing its required `id` (description is OPTIONAL in the frozen shape).
  'option-missing-id': {
    ...BASE_RECORD_UNKNOWN,
    options: [{ label: 'Approve' }],
  },
  // allowFreeText is a REQUIRED boolean — a non-boolean must reject.
  'allow-free-text-non-boolean': {
    ...BASE_RECORD_UNKNOWN,
    allowFreeText: 'yes',
  },
  // gateId is pinned to exactly 24 chars.
  'empty-gate-id': {
    ...BASE_RECORD_UNKNOWN,
    gateId: '',
  },
  'wrong-length-gate-id': {
    ...BASE_RECORD_UNKNOWN,
    gateId: '0123456789abcdef0123', // 20 chars
  },
  'unknown-gate-type': {
    ...BASE_RECORD_UNKNOWN,
    gateType: 'not-a-real-gate-type',
  },
  'invalid-issue-url': {
    ...BASE_RECORD_UNKNOWN,
    issueUrl: 'not-a-url',
  },
  'naive-timestamp': {
    ...BASE_RECORD_UNKNOWN,
    askedAt: 'Tue Jul 21 2026 12:00:00 GMT+0000',
  },
  'record-missing-title': withoutKey(BASE_RECORD_UNKNOWN, 'title'),
  // Down-path: actor.email must be a valid email OR null; a malformed string rejects.
  'answer-invalid-email': {
    ...BASE_ANSWER_UNKNOWN,
    actor: { ...ACTOR, email: 'not-an-email' },
  },
  // Down-path: wrong discriminator (must be the 'gate-answer' literal).
  'answer-wrong-type-literal': {
    ...BASE_ANSWER_UNKNOWN,
    type: 'gate-open',
  },
};
