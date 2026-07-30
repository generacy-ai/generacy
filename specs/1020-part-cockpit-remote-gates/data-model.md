# Data Model: Cockpit Remote Gates — Wire Contracts

**Feature**: `1020-part-cockpit-remote-gates`
**Module**: `packages/cockpit/src/gates/`

This document is the canonical type surface for the three wire contracts. The Zod schemas in `src/gates/schemas.ts` are the source of truth at runtime; TypeScript types are derived via `z.infer`.

## 1. Top-level types

### `GateType` (discriminated string union)

```ts
export const GATE_TYPES = [
  'clarification',
  'artifact-review',
  'implementation-review',
  'manual-validation',
  'escalation',
  'phase-queue',
  'filing',
  'scope-drained',
] as const;

export const GateTypeSchema = z.enum(GATE_TYPES);
export type GateType = z.infer<typeof GateTypeSchema>;
```

Exactly the eight types listed in `spec.md` §Scope.

### `ArtifactReviewKind` (closed local enum, Q5)

```ts
export const ARTIFACT_REVIEW_KINDS = [
  'spec-review',
  'plan-review',
  'tasks-review',
  'clarification-review',
] as const;

export const ArtifactReviewKindSchema = z.enum(ARTIFACT_REVIEW_KINDS);
export type ArtifactReviewKind = z.infer<typeof ArtifactReviewKindSchema>;
```

Deliberately excludes `'implementation-review'` (that's its own top-level `GateType`).

## 2. Sub-schemas

### `IssueRef` (compact `<owner>/<repo>#<number>` shape)

```ts
export const IssueRefSchema = z.object({
  owner: z.string().min(1).regex(/^[a-zA-Z0-9-_.]+$/),
  repo: z.string().min(1).regex(/^[a-zA-Z0-9-_.]+$/),
  number: z.number().int().positive(),
});
export type IssueRef = z.infer<typeof IssueRefSchema>;
```

Used for `epicRef` and `issueRef` fields.

### `Actor`

```ts
export const ActorSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1),
});
export type Actor = z.infer<typeof ActorSchema>;
```

### `GateOption` (element of `options[]`)

Per Q3 clarification (`description` required, `recommended` optional/no default):

```ts
export const GateOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),      // required, Q3=A
  recommended: z.boolean().optional(), // no default, Q3=A
});
export type GateOption = z.infer<typeof GateOptionSchema>;
```

### `GateOutcome`

```ts
export const GATE_OUTCOMES = ['applied', 'superseded', 'failed'] as const;
export const GateOutcomeSchema = z.enum(GATE_OUTCOMES);
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;
```

## 3. Wire contracts

### `GateRecord` (gate-open payload)

```ts
export const GateRecordSchema = z.object({
  // Identity
  gateId: z.string().regex(/^[0-9a-f]{24}$/),           // 24-hex-char sha256 prefix
  gateKey: z.string().min(1),
  gateType: GateTypeSchema,

  // Issue context
  epicRef: IssueRefSchema,
  issueRef: IssueRefSchema,
  issueTitle: z.string().min(1),
  issueUrl: z.string().url(),
  branch: z.string().min(1).optional(),
  prNumber: z.number().int().positive().optional(),

  // Presenter payload
  title: z.string().min(1),
  body: z.string(),                                     // markdown body, empty allowed
  options: z.array(GateOptionSchema).min(0),            // Q3=A — may be empty
  allowFreeText: z.literal(true),                       // Q4=A — invariant

  // Session context
  sessionId: z.string().min(1),
  askedAt: z.string().datetime({ offset: true }),
});
export type GateRecord = z.infer<typeof GateRecordSchema>;
```

**Validation rules baked in**:
- `gateId` MUST be lowercase 24-char hex (24 = the sha256 prefix length spec §Scope requires).
- `issueUrl` MUST be a valid URL.
- `askedAt` MUST be an RFC 3339 timestamp with offset (rejects naive `Date.now().toString()` mistakes).
- `allowFreeText` cannot be `false` — schema-level invariant per Q4.
- No fields beyond those listed — Zod `.object()` is strict-adjacent (see §5 below).

### `GateAnswer` (answer NDJSON line)

```ts
export const GateAnswerSchema = z.object({
  type: z.literal('gate-answer'),                       // NDJSON discriminant
  gateId: z.string().regex(/^[0-9a-f]{24}$/),
  gateKey: z.string().min(1),
  optionId: z.string().min(1).nullable(),               // null when free-text-only answer
  freeText: z.string().optional(),                      // present when operator typed one
  actor: ActorSchema,
  answeredAt: z.string().datetime({ offset: true }),
  deliveryId: z.string().min(1),                        // dedupe key on the driving side
});
export type GateAnswer = z.infer<typeof GateAnswerSchema>;
```

**Validation rule** (enforced with `.refine`):

```ts
.refine(
  (v) => v.optionId !== null || (v.freeText !== undefined && v.freeText.length > 0),
  { message: 'optionId=null requires a non-empty freeText' }
)
```

Rationale: at least one path must carry the answer content. This mirrors the runtime contract on the driving side (an empty answer is unrepresentable).

### `GateOutcomeAck`

```ts
export const GateOutcomeAckSchema = z.object({
  gateId: z.string().regex(/^[0-9a-f]{24}$/),
  outcome: GateOutcomeSchema,
  detail: z.string().min(1).optional(),                 // human-readable explanation
  at: z.string().datetime({ offset: true }),
});
export type GateOutcomeAck = z.infer<typeof GateOutcomeAckSchema>;
```

## 4. Derivation helpers (public API surface)

### `deriveGateKey` — assembles the pre-image string

```ts
export interface DeriveGateKeyInput {
  issueRef: IssueRef;          // <owner>/<repo>#<number>
  gateType: GateType;
  generation: string;          // output of a per-type generation helper
}

export function deriveGateKey(input: DeriveGateKeyInput): string {
  const { issueRef, gateType, generation } = input;
  return `${issueRef.owner}/${issueRef.repo}#${issueRef.number}:${gateType}:${generation}`;
}
```

**Contract**: pure function. Same input → same output byte-for-byte. Never parses back.

### `deriveGateId` — hashes to a 24-hex-char id

```ts
import { createHash } from 'node:crypto';

export function deriveGateId(gateKey: string): string {
  return createHash('sha256').update(gateKey, 'utf8').digest('hex').slice(0, 24);
}
```

**Contract**: pure function. Determinism is load-bearing for restart/takeover idempotency.

### Per-gate-type generation helpers

All live in `src/gates/generation.ts`. Each returns a plain string suitable for `deriveGateKey({ generation })`. Compound inputs are colon-joined lowercase per Q1.

```ts
export interface ClarificationGenerationInput { batchId: string; }
export function deriveClarificationGeneration(i: ClarificationGenerationInput): string;

export interface ArtifactReviewGenerationInput {
  kind: ArtifactReviewKind;      // closed enum per Q5
  headSha: string;               // git SHA (short or long — hashed either way)
}
export function deriveArtifactReviewGeneration(i: ArtifactReviewGenerationInput): string;
// returns `${kind}:${headSha}` — e.g. "spec-review:abc1234"

export interface ImplementationReviewGenerationInput { headSha: string; }
export function deriveImplementationReviewGeneration(i: ImplementationReviewGenerationInput): string;
// returns `${headSha}`

export interface ManualValidationGenerationInput { phaseNumber: number; }
export function deriveManualValidationGeneration(i: ManualValidationGenerationInput): string;
// returns String(phaseNumber)

export interface EscalationGenerationInput {
  subtype: string;               // free string — cloud/driver co-owned vocabulary
  labelOrState: string;          // triggering label ("agent:error") or state name
  counter: number;               // occurrence counter within (issue, subtype)
}
export function deriveEscalationGeneration(i: EscalationGenerationInput): string;
// returns `${subtype}:${labelOrState}:${counter}` — e.g. "stalled:agent:error:3"
// Note: labelOrState may itself contain colons — that's fine, gateKey is opaque.

export interface PhaseQueueGenerationInput { phaseNumber: number; }
export function derivePhaseQueueGeneration(i: PhaseQueueGenerationInput): string;
// returns String(phaseNumber)

export interface FilingGenerationInput { draftHash: string; }
export function deriveFilingGeneration(i: FilingGenerationInput): string;
// returns draftHash

export interface ScopeDrainedGenerationInput {
  trackingIssueRef: IssueRef;
  counter: number;
}
export function deriveScopeDrainedGeneration(i: ScopeDrainedGenerationInput): string;
// returns `${owner}/${repo}#${number}:${counter}`
```

**Validation strategy**: each helper's input is a plain interface (no Zod parse at helper level — helpers are pure formatters, cheap, called on hot paths). Callers that ingest untrusted data (e.g. the cloud reads a webhook body) validate at the boundary before passing to helpers.

The only helper input with a schema-enforced enum is `ArtifactReviewGenerationInput.kind` — TypeScript's structural typing catches at compile time; runtime callers who bypass TS can additionally opt-in via `ArtifactReviewKindSchema.parse(kind)` before the call.

## 5. Round-trip / strictness policy

- Schemas use plain `z.object()` (not `.strict()`). Rationale: allows a *forward-compat* additive field to appear without failing downstream validators. Wire-contract changes remain a coordinated epic-level decision — passthrough of unknown fields is a **compat-benefit**, not a laxness bug.
- `z.infer` types must round-trip: `parse(JSON.parse(JSON.stringify(record))) → equal to record`. Fixtures verify this (see `gates-schemas.test.ts`).
- Timestamps are strings, not `Date`, to keep JSON-in / JSON-out symmetry.

## 6. Relationships

```
GateRecord (emitted by driving session)
      │  gateId ─────────────┐
      │                       │
      ▼                       ▼
GateAnswer (returned by cloud/operator, references same gateId)
      │
      ▼
GateOutcomeAck (emitted by driving session, references same gateId)
```

`gateId` is the correlation identifier across all three records. `gateKey` is only present on the open record + answer (the ack references by id alone).

## 7. Public export surface (added to `packages/cockpit/src/index.ts`)

```ts
// Wire contracts — see specs/1020-part-cockpit-remote-gates/
export {
  // Schemas
  GateRecordSchema,
  GateAnswerSchema,
  GateOutcomeAckSchema,
  GateOptionSchema,
  IssueRefSchema,
  ActorSchema,
  // Enums
  GateTypeSchema,
  GATE_TYPES,
  ArtifactReviewKindSchema,
  ARTIFACT_REVIEW_KINDS,
  GateOutcomeSchema,
  GATE_OUTCOMES,
  // Types
  type GateType,
  type ArtifactReviewKind,
  type GateOutcome,
  type GateOption,
  type IssueRef,
  type Actor,
  type GateRecord,
  type GateAnswer,
  type GateOutcomeAck,
  // Derivation
  deriveGateKey,
  deriveGateId,
  deriveClarificationGeneration,
  deriveArtifactReviewGeneration,
  deriveImplementationReviewGeneration,
  deriveManualValidationGeneration,
  deriveEscalationGeneration,
  derivePhaseQueueGeneration,
  deriveFilingGeneration,
  deriveScopeDrainedGeneration,
  // Fixtures
  VALID_FIXTURES,
  MALFORMED_FIXTURES,
  VALID_ANSWER_FIXTURES,
  VALID_ACK_FIXTURES,
} from './gates/index.js';
```

No new subpath entry; no new dep; no change to `package.json` `exports`.
