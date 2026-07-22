import { deriveGateKey, deriveGateId } from './gate-id.js';
import {
  deriveClarificationGeneration,
  deriveArtifactReviewGeneration,
  deriveImplementationReviewGeneration,
  deriveManualValidationGeneration,
  deriveEscalationGeneration,
  derivePhaseQueueGeneration,
  deriveFilingGeneration,
  deriveScopeDrainedGeneration,
} from './generation.js';
import {
  GateAnswerSchema,
  GateOutcomeAckSchema,
  GateRecordSchema,
  type GateAnswer,
  type GateOutcomeAck,
  type GateRecord,
  type IssueRef,
} from './schemas.js';
import type { GateType } from './types.js';

const EPIC_REF: IssueRef = { owner: 'generacy-ai', repo: 'generacy', number: 1000 };
const ISSUE_REF: IssueRef = { owner: 'generacy-ai', repo: 'generacy', number: 1020 };
const TRACKING_REF: IssueRef = { owner: 'generacy-ai', repo: 'generacy', number: 900 };
const SESSION_ID = 'sess-abc123def456';
const ASKED_AT = '2026-07-21T12:00:00.000Z';
const ANSWERED_AT = '2026-07-21T12:05:00.000Z';
const ACK_AT = '2026-07-21T12:05:01.000Z';

const ACTOR = {
  userId: 'user-1',
  email: 'operator@example.com',
  displayName: 'Operator One',
} as const;

const DEFAULT_OPTIONS = [
  { id: 'opt-a', label: 'Approve', description: 'Approve and proceed' },
  { id: 'opt-b', label: 'Reject', description: 'Reject and halt', recommended: true },
] as const;

interface GenerationBundle {
  gateType: GateType;
  generation: string;
}

const GENERATIONS: Record<GateType, GenerationBundle> = {
  clarification: {
    gateType: 'clarification',
    generation: deriveClarificationGeneration({ batchId: 'batch-abc123' }),
  },
  'artifact-review': {
    gateType: 'artifact-review',
    generation: deriveArtifactReviewGeneration({ kind: 'spec-review', headSha: 'abc1234' }),
  },
  'implementation-review': {
    gateType: 'implementation-review',
    generation: deriveImplementationReviewGeneration({ headSha: 'def5678' }),
  },
  'manual-validation': {
    gateType: 'manual-validation',
    generation: deriveManualValidationGeneration({ phaseNumber: 2 }),
  },
  escalation: {
    gateType: 'escalation',
    generation: deriveEscalationGeneration({
      subtype: 'stalled',
      labelOrState: 'agent:error',
      counter: 1,
    }),
  },
  'phase-queue': {
    gateType: 'phase-queue',
    generation: derivePhaseQueueGeneration({ phaseNumber: 3 }),
  },
  filing: {
    gateType: 'filing',
    generation: deriveFilingGeneration({ draftHash: 'feedbeef1234' }),
  },
  'scope-drained': {
    gateType: 'scope-drained',
    generation: deriveScopeDrainedGeneration({ trackingIssueRef: TRACKING_REF, counter: 1 }),
  },
};

function buildRecord(gateType: GateType): GateRecord {
  const { generation } = GENERATIONS[gateType];
  const gateKey = deriveGateKey({ issueRef: ISSUE_REF, gateType, generation });
  const gateId = deriveGateId(gateKey);
  return {
    gateId,
    gateKey,
    gateType,
    epicRef: EPIC_REF,
    issueRef: ISSUE_REF,
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

export const VALID_FIXTURES: Record<GateType, GateRecord> = {
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
  GateRecordSchema.parse(VALID_FIXTURES[gateType]);
}

interface AnswerSpec {
  optionId: string | null;
  freeText?: string;
}

const ANSWER_SPECS: Record<GateType, AnswerSpec> = {
  clarification: { optionId: 'opt-a' },
  'artifact-review': { optionId: null, freeText: 'approve with concerns' },
  'implementation-review': { optionId: 'opt-a' },
  'manual-validation': { optionId: null, freeText: 'verified manually on 2026-07-21' },
  escalation: { optionId: 'opt-a' },
  'phase-queue': { optionId: null, freeText: 'proceed with next phase' },
  filing: { optionId: 'opt-a' },
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
    ...(spec.freeText !== undefined ? { freeText: spec.freeText } : {}),
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

export const VALID_ACK_FIXTURES: Record<'applied' | 'superseded' | 'failed', GateOutcomeAck> = {
  applied: {
    gateId: VALID_FIXTURES.clarification.gateId,
    outcome: 'applied',
    at: ACK_AT,
  },
  superseded: {
    gateId: VALID_FIXTURES['artifact-review'].gateId,
    outcome: 'superseded',
    detail: 'A newer answer arrived first',
    at: ACK_AT,
  },
  failed: {
    gateId: VALID_FIXTURES.escalation.gateId,
    outcome: 'failed',
    detail: 'Label mutation returned 422',
    at: ACK_AT,
  },
};

for (const key of Object.keys(VALID_ACK_FIXTURES) as Array<keyof typeof VALID_ACK_FIXTURES>) {
  GateOutcomeAckSchema.parse(VALID_ACK_FIXTURES[key]);
}

const BASE_RECORD_UNKNOWN = VALID_FIXTURES.clarification as unknown as Record<string, unknown>;
const BASE_ANSWER_UNKNOWN = VALID_ANSWER_FIXTURES.clarification as unknown as Record<
  string,
  unknown
>;

function withoutKey<T extends Record<string, unknown>>(obj: T, key: string): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...obj };
  delete clone[key];
  return clone;
}

export const MALFORMED_FIXTURES: Record<string, unknown> = {
  'missing-description': {
    ...BASE_RECORD_UNKNOWN,
    options: [{ id: 'opt-a', label: 'Approve' }],
  },
  'allow-free-text-false': {
    ...BASE_RECORD_UNKNOWN,
    allowFreeText: false,
  },
  'empty-gate-id': {
    ...BASE_RECORD_UNKNOWN,
    gateId: '',
  },
  'unknown-gate-type': {
    ...BASE_RECORD_UNKNOWN,
    gateType: 'not-a-real-gate-type',
  },
  'non-hex-gate-id-prefix': {
    ...BASE_RECORD_UNKNOWN,
    gateId: 'ZZZZZZZZZZZZZZZZZZZZZZZZ',
  },
  'invalid-issue-url': {
    ...BASE_RECORD_UNKNOWN,
    issueUrl: 'not-a-url',
  },
  'naive-timestamp': {
    ...BASE_RECORD_UNKNOWN,
    askedAt: 'Tue Jul 21 2026 12:00:00 GMT+0000',
  },
  'answer-null-option-empty-free-text': {
    ...BASE_ANSWER_UNKNOWN,
    optionId: null,
    freeText: '',
  },
  // Additional coverage: missing required field, invalid actor email.
  'record-missing-title': withoutKey(BASE_RECORD_UNKNOWN, 'title'),
  'answer-invalid-email': {
    ...BASE_ANSWER_UNKNOWN,
    actor: { ...ACTOR, email: 'not-an-email' },
  },
};
