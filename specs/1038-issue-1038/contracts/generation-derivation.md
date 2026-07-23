# Contract: `generation` derivation per gate type

**Kind**: Pure helpers (no I/O, deterministic)
**Package**: `@generacy-ai/cockpit` (`packages/cockpit/src/gates/generation.ts` + new `clarification-hash.ts`)
**Related**: [`cockpit_gate_status.md`](./cockpit_gate_status.md)

---

## Purpose

Define the **canonical inputs** to `generation` for each of the 8 gate types, so
that a `gateId` computed by the agency-side sweep equals the `gateId` computed
by the live in-repo path (SC-002).

The derivation helpers themselves are pure functions:

- **Sweep** reads GitHub state (issue comments, PR head SHA, artifact SHA) and
  projects to the helper's input shape.
- **Live path** reads the same GitHub state (through its own code path) and
  projects to the same input shape.
- Same input → same output → same `gateId`.

Any drift between the two callsites is a spec violation (FR-009).

---

## Common shape

```ts
gateKey = `${issueRef}:${gateType}:${generation}`
gateId  = sha256(gateKey).slice(0, 24)     // hex
```

`generation` is always a string. Number inputs are coerced (`String(n)`).

---

## Per-gate-type canonicalization

### `clarification` — NEW helper (Q1 → A / FR-006)

**Canonical input**: sorted-by-`questionNumber` list of `{ questionNumber, questionText }` for every question in the current *unanswered* batch. Question identity only; drafted/pending answers excluded.

**Rule**: "Same round of asks → same generation."

**Helper** (NEW):

```ts
import { computeClarificationAnswerSetHash } from '@generacy-ai/cockpit';

const batchId = computeClarificationAnswerSetHash({
  questions: [
    { questionNumber: 1, questionText: 'Which auth method?' },
    { questionNumber: 2, questionText: 'Which DB?' },
    { questionNumber: 3, questionText: 'Timezone?' },
  ],
});
// batchId → 12-hex string, e.g. 'a1b2c3d4e5f6'
```

Then feed into the existing `deriveClarificationGeneration`:

```ts
const generation = deriveClarificationGeneration({ batchId });
```

**Algorithm** (locked by SC-002):

1. Sort the list ascending by `questionNumber`.
2. Project each question to exactly `{ questionNumber, questionText }` (drop any extra fields — this is what mechanically enforces "answers excluded").
3. `JSON.stringify` the projected array.
4. `sha256` the canonical string.
5. Take the first 12 hex characters.

**Non-goals**:
- Cross-batch stability: a *new batch* (different question set) is a legitimately different `generation`.
- Answer stability: answers are not in the hash — answering a question does NOT change the `generation`. Progress on an existing gate flows via the cloud's answer/apply lifecycle, not by re-opening under a new discriminator.

**Fixture parity (SC-002)**:
- `packages/cockpit/src/gates/fixtures.ts` — new `CLARIFICATION_ANSWER_SET_FIXTURES` map with representative sets (single-question, three-question, unicode, out-of-order-input).
- `packages/cockpit/src/gates/__tests__/generation-parity.test.ts` — asserts that for each fixture, `computeClarificationAnswerSetHash` applied to two independently-constructed copies (simulating sweep and live paths) produces byte-identical output.

---

### `implementation-review` — existing helper (FR-007)

**Canonical input**: PR head SHA (git commit sha as a string). Truncation is caller-discretion but consumers SHOULD use the full 40-char sha to avoid collision.

**Helper** (UNCHANGED):

```ts
const generation = deriveImplementationReviewGeneration({ headSha: 'abc1234' });
// generation === 'abc1234'
```

**Fixture parity (SC-002)**:
- Same fixture-based test asserts sweep-derived vs live-derived `gateId` match for the same `(issueRef, headSha)`.

**Non-goals**:
- Including base SHA: rebase/merge already produces a new head SHA; adding base salts nothing.
- Truncating head SHA in the helper: the helper stays a straight passthrough; truncation policy (if any) lives at the caller.

---

### `artifact-review` — existing helper (FR-008)

**Canonical input**: `{ kind: ArtifactReviewKind, headSha: string }` where `kind` is one of the four values in the closed enum (`spec-review | plan-review | tasks-review | clarification-review`) and `headSha` is the commit sha of the artifact.

**Helper** (UNCHANGED):

```ts
const generation = deriveArtifactReviewGeneration({ kind: 'spec-review', headSha: 'def5678' });
// generation === 'spec-review:def5678'
```

**Fixture parity (SC-002)**:
- Optional — the primary SC-002 targets are `clarification` and `implementation-review` per spec § Out-of-Scope. Add a fixture entry per artifact kind for defensive coverage.

---

### `manual-validation` — existing helper (FR-008)

**Canonical input**: `{ phaseNumber: number }` where `phaseNumber` is the workflow phase number of what is being validated.

**Helper** (UNCHANGED):

```ts
const generation = deriveManualValidationGeneration({ phaseNumber: 2 });
// generation === '2'
```

**Note**: the spec's FR-008 phrasing ("head SHA of what is being validated") differs from the existing helper's shape. **Plan decision**: keep the existing `phaseNumber` shape unchanged — it's the frozen input consumers already project to. If a future feature requires SHA-based validation gate identity, it is a spec change, not a plan-phase decision. Documented here so reviewers see the divergence and don't accidentally file it as a bug.

---

### `escalation` — existing helper (FR-008)

**Canonical input**: `{ subtype: string, labelOrState: string, counter: number }`. Occurrence counter is derived from durable GitHub state (e.g., issue-comment count of a filter).

**Helper** (UNCHANGED):

```ts
const generation = deriveEscalationGeneration({
  subtype: 'label-flip',
  labelOrState: 'agent:error',
  counter: 3,
});
// generation === 'label-flip:agent:error:3'
```

**Fixture parity**: not required for SC-002; existing #1020 fixtures cover the string shape.

---

### `phase-queue`, `filing`, `scope-drained` — out of scope for SC-002

Existing helpers (`derivePhaseQueueGeneration`, `deriveFilingGeneration`,
`deriveScopeDrainedGeneration`) are documented as canonical here but do not
get new fixture parity tests. Spec § Out-of-Scope excludes them from the
matrix — the sweep does not touch these types today.

Existing shapes:

```ts
derivePhaseQueueGeneration({ phaseNumber: 3 })                                     // '3'
deriveFilingGeneration({ draftHash: 'feedbeef1234' })                              // 'feedbeef1234'
deriveScopeDrainedGeneration({ trackingIssueRef: { owner, repo, number }, counter }) // 'owner/repo#N:counter'
```

---

## Cross-boundary contract

Every caller of these helpers MUST project GitHub state to the exact input
shape shown above. In particular:

- No extra fields on the `ClarificationQuestion` object end up in the hash
  (the projection at step 2 of the algorithm strips them).
- Head SHAs are compared byte-for-byte; abbreviated vs full SHAs would produce
  different `generation` strings. Callers on both sides MUST use the same
  representation (full 40-char SHA recommended).
- Numeric inputs (`phaseNumber`, `counter`) are coerced via `String(n)` — the
  helper does that internally. Passing `'2'` vs `2` produces the same output.
