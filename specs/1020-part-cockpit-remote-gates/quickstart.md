# Quickstart: `@generacy-ai/cockpit` gates module

**Feature**: `1020-part-cockpit-remote-gates`
**Audience**: downstream authors of orchestrator routes, MCP tools, doorbell, and the generacy-cloud mirror.

## Install / consume

The gates module ships from the existing root export of `@generacy-ai/cockpit`. No new package, no new subpath.

```ts
import {
  GateRecordSchema,
  GateAnswerSchema,
  GateOutcomeAckSchema,
  deriveGateKey,
  deriveGateId,
  deriveArtifactReviewGeneration,
  VALID_FIXTURES,
  type GateRecord,
  type GateType,
} from '@generacy-ai/cockpit';
```

Workspace consumers (orchestrator, generacy CLI, doorbell) already depend on `@generacy-ai/cockpit` via `workspace:*` — no `package.json` edit required in downstream packages.

## Emit a gate (driving-session pattern)

```ts
import { createHash } from 'node:crypto';
import {
  deriveArtifactReviewGeneration,
  deriveGateKey,
  deriveGateId,
  GateRecordSchema,
  type GateRecord,
} from '@generacy-ai/cockpit';

function openSpecReviewGate(input: {
  epicRef: { owner: string; repo: string; number: number };
  issueRef: { owner: string; repo: string; number: number };
  issueTitle: string;
  issueUrl: string;
  headSha: string;
  sessionId: string;
  branch?: string;
  prNumber?: number;
}): GateRecord {
  const generation = deriveArtifactReviewGeneration({
    kind: 'spec-review',
    headSha: input.headSha,
  });
  const gateKey = deriveGateKey({
    issueRef: input.issueRef,
    gateType: 'artifact-review',
    generation,
  });
  const gateId = deriveGateId(gateKey);

  const record: GateRecord = {
    gateId,
    gateKey,
    gateType: 'artifact-review',
    epicRef: input.epicRef,
    issueRef: input.issueRef,
    issueTitle: input.issueTitle,
    issueUrl: input.issueUrl,
    branch: input.branch,
    prNumber: input.prNumber,
    title: 'Approve the drafted spec?',
    body: 'The spec draft is ready for your review.',
    options: [
      { id: 'approve', label: 'Approve', description: 'Advance to /plan.' },
      { id: 'revise', label: 'Revise', description: 'Return the draft with comments.' },
    ],
    allowFreeText: true,     // literal true — schema enforces it
    sessionId: input.sessionId,
    askedAt: new Date().toISOString(),
  };

  // Fail-loud at construction — never publish a malformed record.
  return GateRecordSchema.parse(record);
}
```

## Consume an answer (cloud / operator pattern)

```ts
import { GateAnswerSchema, type GateAnswer } from '@generacy-ai/cockpit';

function parseIncomingAnswer(ndjsonLine: string): GateAnswer {
  const parsed = JSON.parse(ndjsonLine);
  return GateAnswerSchema.parse(parsed);  // throws on malformed input
}
```

Handling the discriminated `optionId` / `freeText` shape:

```ts
if (answer.optionId !== null) {
  applyChosenOption(answer.optionId);
} else {
  // Schema guarantees freeText is present + non-empty when optionId is null.
  applyFreeText(answer.freeText!);
}
```

## Publish an outcome ack

```ts
import { GateOutcomeAckSchema, type GateOutcomeAck } from '@generacy-ai/cockpit';

const ack: GateOutcomeAck = GateOutcomeAckSchema.parse({
  gateId: answer.gateId,
  outcome: 'applied',
  detail: 'Advanced to plan phase.',
  at: new Date().toISOString(),
});
```

## Determinism: `gateId` is a hash of the pre-image

Two runs of the driving session (a restart, a takeover from a fresh MCP process) that hit the same *natural* gate MUST produce the same `gateId`. This is what makes the inbox idempotent — re-emission does not create a duplicate row.

To verify locally:

```ts
const gen = deriveArtifactReviewGeneration({ kind: 'plan-review', headSha: 'abc1234' });
const key = deriveGateKey({
  issueRef: { owner: 'generacy-ai', repo: 'generacy', number: 1020 },
  gateType: 'artifact-review',
  generation: gen,
});
const id = deriveGateId(key);
// key === 'generacy-ai/generacy#1020:artifact-review:plan-review:abc1234'
// id  === first 24 hex chars of sha256(key), byte-identical across processes
```

## Test fixtures

For downstream tests, import the shared fixtures rather than hand-rolling records:

```ts
import { VALID_FIXTURES, MALFORMED_FIXTURES } from '@generacy-ai/cockpit';

test('orchestrator accepts every valid gate type', () => {
  for (const record of Object.values(VALID_FIXTURES)) {
    expect(() => routeHandler(record)).not.toThrow();
  }
});

test('orchestrator rejects a missing-description option', () => {
  expect(() => routeHandler(MALFORMED_FIXTURES['missing-description'])).toThrow();
});
```

The cloud mirror (generacy-cloud) reads the JSON Schemas checked in at
[`specs/1020-part-cockpit-remote-gates/contracts/`](./contracts/) as its wire-contract
source of truth, since it does not consume this npm package directly.

## Available exports (quick reference)

| Category | Symbol |
|---|---|
| Schemas | `GateRecordSchema`, `GateAnswerSchema`, `GateOutcomeAckSchema`, `GateOptionSchema`, `IssueRefSchema`, `ActorSchema` |
| Enums | `GateTypeSchema` / `GATE_TYPES`, `ArtifactReviewKindSchema` / `ARTIFACT_REVIEW_KINDS`, `GateOutcomeSchema` / `GATE_OUTCOMES` |
| Types | `GateRecord`, `GateAnswer`, `GateOutcomeAck`, `GateOption`, `IssueRef`, `Actor`, `GateType`, `ArtifactReviewKind`, `GateOutcome` |
| Derivation | `deriveGateKey`, `deriveGateId` |
| Generation helpers | `deriveClarificationGeneration`, `deriveArtifactReviewGeneration`, `deriveImplementationReviewGeneration`, `deriveManualValidationGeneration`, `deriveEscalationGeneration`, `derivePhaseQueueGeneration`, `deriveFilingGeneration`, `deriveScopeDrainedGeneration` |
| Fixtures | `VALID_FIXTURES`, `MALFORMED_FIXTURES`, `VALID_ANSWER_FIXTURES`, `VALID_ACK_FIXTURES` |

## Troubleshooting

- **`Error: Invalid gateId`** — `gateId` must be exactly 24 lowercase hex chars. Use `deriveGateId` rather than hand-building an id.
- **`Error: Invalid literal value, expected true` on `allowFreeText`** — this is intentional (Q4 invariant). Every gate keeps a free-text escape hatch; there is no way to emit `allowFreeText: false`.
- **`Error: optionId=null requires a non-empty freeText`** — the operator answered with neither an option nor free-text. Either populate `optionId` or the `freeText` field.
- **My generation string contains extra colons (`stalled:agent:error:3`)** — that's fine. `gateKey` is opaque; no code splits on colons. Only the sha256 output matters.
- **Two processes produced different `gateId`s for what should be the same gate** — you almost certainly passed different inputs to the generation helper. `deriveGateId` is a pure hash; any drift is upstream. Check `headSha` normalization (short vs long SHA), `phaseNumber` typing, and counter alignment.
- **Downstream import fails with "no export named GateRecordSchema"** — you probably imported from `@generacy-ai/cockpit/gates` (which does not exist). Import from the package root: `import { GateRecordSchema } from '@generacy-ai/cockpit'` (Q2=A).

## Related documents

- [`spec.md`](./spec.md) — feature specification
- [`clarifications.md`](./clarifications.md) — Q1–Q5 with rationale
- [`research.md`](./research.md) — technology decisions
- [`data-model.md`](./data-model.md) — full type surface
- [`contracts/`](./contracts/) — JSON Schema mirror for cross-repo consumers
- Epic plan doc: [`cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)
