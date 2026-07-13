# Data Model: deterministic issue→PR resolver

**Feature**: #904 — resolver precedence + draft rejection + loud ambiguity
**Branch**: `904-found-during-cockpit-v1`
**Date**: 2026-07-10
**Phase**: 1 — types, contracts, and validation rules

---

## Stable interfaces (unchanged)

### `PullRequestRef`

```ts
export interface PullRequestRef {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  headRefName: string;
}
```

Unchanged. This is the per-PR shape shared across `resolveIssueToPRRef` (post-change), `findOpenPrForBranch`, and the tier-internal candidate lists.

### `IssueRefWithState`

Unchanged from `packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts:5`.

---

## New types

### `LinkMethod`

```ts
export type LinkMethod = 'closing-refs' | 'branch-name' | 'pr-body';
```

Named union of the three resolution tiers in FR-001..FR-003 order. Consumers must not depend on the specific string values beyond equality — they are stable identifiers, not human copy. Serialized verbatim into the JSON payload's `linkMethod` field and into the `resolved PR #N via <linkMethod>` log line.

### `PrCandidate`

```ts
export interface PrCandidate {
  number: number;
  url: string;
  isDraft: boolean;
  headRefName: string;
}
```

The reduced-shape carried in `candidates: PrCandidate[]` for multi-candidate ambiguity/only-drafts payloads. Distinct from `PullRequestRef` (which has `state`) — the candidate list is always open-PRs-only, so `state` is implicit. `isDraft` is retained explicitly because the `pr-is-draft` case must be operator-readable at a glance.

Serialization: verbatim JSON, no transformation.

### `PullRequestRefResolution`

```ts
export type PullRequestRefResolution =
  | { kind: 'resolved';    ref: PullRequestRef;         linkMethod: LinkMethod }
  | { kind: 'ambiguous';   candidates: PullRequestRef[]; linkMethod: LinkMethod }
  | { kind: 'pr-is-draft'; candidates: PullRequestRef[]; linkMethod: LinkMethod }
  | { kind: 'unresolved' };
```

The discriminated-union return type of `resolveIssueToPRRef` per FR-009 (Q5-B). Notes:

- `candidates` on `ambiguous` and `pr-is-draft` uses the full `PullRequestRef` (not `PrCandidate`) because the resolver already has the full shape and the caller may need `state` downstream. The `runMerge` payload projection strips `state` before serializing.
- `unresolved` is a zero-field variant. No `null`, no error.
- `linkMethod` is absent from `unresolved` intentionally — there is no tier to name when nothing was found.
- Invariant I-1: on `ambiguous`, `candidates.length >= 2`.
- Invariant I-2: on `pr-is-draft`, `candidates.length >= 1` AND every candidate has `draft: true`.
- Invariant I-3: on `resolved`, `ref.draft === false`.

Enforcement of I-1..I-3 lives inside the resolver — callers may `assert`/exhaust the union but do not re-check invariants.

---

## Per-tier decision matrix

Applied identically at each of Tier 1 (closing-refs), Tier 2 (branch-name), Tier 3 (pr-body):

| Open PR count | Non-draft count | Draft count | Result kind             | Falls through? |
|---------------|-----------------|-------------|-------------------------|----------------|
| 0             | 0               | 0           | (n/a — no result)       | **Yes**        |
| ≥1            | 1               | any         | `resolved` (that PR)    | No             |
| ≥2            | ≥2              | any         | `ambiguous` (all non-drafts) | No        |
| ≥1            | 0               | ≥1          | `pr-is-draft` (all drafts)   | No        |

Notes:
- "Fall through" means: the tier produced no result → try the next tier.
- The "≥2 non-drafts" row never contains drafts — the candidates list is the non-draft filter output. Drafts at this tier are silently dropped (they can't be merged, so their presence isn't ambiguity-signalling per Q1-B / Q2-B).
- Tier 3 (`pr-body`) is the last tier. If it also falls through, the outer resolver returns `{ kind: 'unresolved' }`.

Pseudocode (single per-tier evaluator):

```ts
function evaluateTier(
  candidates: PullRequestRef[],
  linkMethod: LinkMethod,
): PullRequestRefResolution | null /* fall-through sentinel */ {
  const nonDrafts = candidates.filter(p => !p.draft);
  if (nonDrafts.length === 1) return { kind: 'resolved', ref: nonDrafts[0]!, linkMethod };
  if (nonDrafts.length >= 2)  return { kind: 'ambiguous', candidates: nonDrafts, linkMethod };
  const drafts = candidates.filter(p => p.draft);
  if (drafts.length >= 1)     return { kind: 'pr-is-draft', candidates: drafts, linkMethod };
  return null; // fall through
}
```

---

## Changed function contract: `resolveIssueToPRRef`

**Before** (`packages/cockpit/src/gh/wrapper.ts:128`):

```ts
resolveIssueToPRRef(repo: string, issue: number): Promise<PullRequestRef | null>;
```

**After**:

```ts
resolveIssueToPRRef(repo: string, issue: number): Promise<PullRequestRefResolution>;
```

**Semantics**:

1. Query Tier 1 (`gh issue view <n> --json closingIssuesReferences,…`). Apply `evaluateTier(candidates, 'closing-refs')`. If non-null, return.
2. Query Tier 2 (`gh pr list --search "head:<issue>-" --state open --json …`). Apply `evaluateTier(candidates, 'branch-name')`. If non-null, return.
3. Query Tier 3 (`gh pr list --search "<issue> in:body" --state open --json …`). Apply `evaluateTier(candidates, 'pr-body')`. If non-null, return.
4. Return `{ kind: 'unresolved' }`.

**Ordering guarantees**:
- Tier queries execute **in order** — Tier 2 only runs if Tier 1 falls through; Tier 3 only runs if Tier 2 falls through.
- No parallelization. This is a "cheapest first" pattern: Tier 1 uses the same JSON view we already query for issue metadata; Tier 2/3 both cost a `pr list --search`.
- Each tier's `gh` call is retried per the existing runner's retry policy — no new retry surface added.

**Error handling**: any tier's `gh` call failing (non-zero exit, malformed JSON, schema mismatch) throws the same shape of error as today (`gh <op> failed (exit <n>): <stderr>`). Tier failure does NOT fall through — a failed Tier 1 does not silently proceed to Tier 2. Rationale: a `gh` failure at Tier 1 means we couldn't establish the authoritative signal; silently downgrading to a weaker tier would be Q5's TOCTOU flaw at query-time.

---

## Changed function contract: `runMerge` switch

**Before** (`merge.ts:85-97`):

```ts
const prRef = await gh.resolveIssueToPRRef(repo, issue);
if (prRef == null) {
  return { exitCode: 1, stdout: serializeFailingCheckJson(buildFailingCheckPayload({ reason: 'unresolved', pr: null, issue: issueRef })) };
}
```

**After** (sketch):

```ts
const resolution = await gh.resolveIssueToPRRef(repo, issue);
switch (resolution.kind) {
  case 'unresolved':
    return redPayload({ reason: 'unresolved', pr: null });
  case 'pr-is-draft':
    return draftPayload(resolution.candidates, resolution.linkMethod);
  case 'ambiguous':
    return ambiguousPayload(resolution.candidates, resolution.linkMethod);
  case 'resolved':
    // FR-004: log BEFORE gh pr merge
    logger.info({ pr: resolution.ref.number, linkMethod: resolution.linkMethod }, `resolved PR #${resolution.ref.number} via ${resolution.linkMethod}`);
    // ... existing state/label/checks flow, threading resolution.linkMethod into the payload
}
```

- `draftPayload` and `ambiguousPayload` never invoke `gh pr merge`. Exit code 1.
- The `resolved` branch threads `resolution.linkMethod` into the existing `missing-label` and `checks-failing` payload construction sites so those failure paths also carry `linkMethod` (per FR-004: "every failure path's stdout JSON carries the same `linkMethod`").
- The `resolved` branch's log line lands **before** the state fetch, label check, and merge call — so a later gh failure never erases the evidence of which PR was targeted.

---

## Changed data type: `FailingCheckPayload`

**Before** (`shared/failing-check-json.ts:13`):

```ts
export type RedReason = 'checks-failing' | 'missing-label' | 'unresolved';

export interface FailingCheckPayload {
  status: 'red';
  reason: RedReason;
  pr: { number: number; url: string } | null;
  failingChecks: FailingCheck[];
  issue?: IssueRefWithState;
}
```

**After**:

```ts
export type RedReason =
  | 'checks-failing'
  | 'missing-label'
  | 'unresolved'
  | 'pr-is-draft'
  | 'ambiguous-resolution';

export interface PrRefWithLinkMethod {
  number: number;
  url: string;
  linkMethod: LinkMethod; // optional at runtime; see invariants below
}

export interface FailingCheckPayload {
  status: 'red';
  reason: RedReason;
  pr: { number: number; url: string; linkMethod?: LinkMethod } | null;
  candidates?: PrCandidate[];  // only present for multi-candidate reasons
  linkMethod?: LinkMethod;     // only present for multi-candidate reasons (top-level)
  failingChecks: FailingCheck[];
  issue?: IssueRefWithState;
}
```

### Payload invariants (per reason)

| reason                | `pr`                                                 | `linkMethod` (top-level) | `candidates`         | `failingChecks` |
|-----------------------|------------------------------------------------------|--------------------------|----------------------|-----------------|
| `unresolved`          | `null` OR `{ number, url }` (no `linkMethod`)        | absent                   | absent               | `[]`            |
| `missing-label`       | `{ number, url, linkMethod }` — **non-null**         | absent                   | absent               | `[]`            |
| `checks-failing`      | `{ number, url, linkMethod }` — **non-null**         | absent                   | absent               | `≥1`            |
| `pr-is-draft` (n=1)   | `null`                                               | required                 | `≥1` (all draft)     | `[]`            |
| `pr-is-draft` (n≥2)   | `null`                                               | required                 | `≥1` (all draft)     | `[]`            |
| `ambiguous-resolution`| `null`                                               | required                 | `≥2` (all non-draft) | `[]`            |

Notes:
- The `pr-is-draft` row collapses n=1 and n=2 into the same shape per clarification Q3-C. Single-candidate drafts still go on `candidates`, not on `pr`, because "not mergeable" is the payload's story — putting a single draft on the resolved-shape `pr` field would misleadingly suggest it was targeted.
- `unresolved`'s `pr` field stays permissive of `{ number, url }` (without `linkMethod`) because there's one legacy path in `merge.ts:99-113` that carries a PR ref found by `resolveIssueToPRRef` but rejected because its state !== 'OPEN'. That path retains the existing shape for zero-churn; `linkMethod` is intentionally absent because "unresolved" already carries a broken-state connotation and adding `linkMethod` would suggest a happy-path resolution.
- `missing-label` and `checks-failing`'s `pr` field becomes non-optional-linkMethod after the switch — every `runMerge` call site that emits these reasons has a `resolution.linkMethod` in scope from the resolved-branch switch.

### `buildFailingCheckPayload` — new invariants

Added to the existing invariant checks in `shared/failing-check-json.ts`:

- I-7: `reason === 'pr-is-draft'` requires `pr === null`, `candidates.length >= 1`, every `candidates[i].isDraft === true`, `linkMethod` set, `failingChecks.length === 0`.
- I-8: `reason === 'ambiguous-resolution'` requires `pr === null`, `candidates.length >= 2`, every `candidates[i].isDraft === false`, `linkMethod` set, `failingChecks.length === 0`.
- I-9: For `reason ∈ { 'missing-label', 'checks-failing' }`, the `pr` field's `linkMethod` MUST be set (upgraded from optional-in-type to required-at-runtime).
- I-10: `candidates` MUST NOT be set for `reason ∈ { 'unresolved', 'missing-label', 'checks-failing' }`.
- I-11: Top-level `linkMethod` MUST NOT be set for `reason ∈ { 'unresolved', 'missing-label', 'checks-failing' }`.

Invariants I-1..I-6 from the pre-change payload are preserved verbatim.

---

## Changed JSON schema

Reference: `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json`.

**Required changes** (details in `contracts/failing-check-payload.md`):

1. `reason` enum grows from `["checks-failing", "missing-label", "unresolved"]` to `["checks-failing", "missing-label", "unresolved", "pr-is-draft", "ambiguous-resolution"]`.
2. `pr` schema's oneOf gains a third variant with a `linkMethod: { enum: [...] }` field:
   ```json
   { "type": "object", "required": ["number", "url", "linkMethod"], "additionalProperties": false, "properties": { "number": ..., "url": ..., "linkMethod": { "enum": ["closing-refs", "branch-name", "pr-body"] } } }
   ```
3. New optional top-level `linkMethod` and `candidates` fields, each with an `if/then` `allOf` clause tying them to `reason ∈ { pr-is-draft, ambiguous-resolution }`.
4. Two new `allOf` if/then clauses: one for `pr-is-draft` (requires `candidates.minItems: 1`, all `isDraft: true`, `pr: null`), one for `ambiguous-resolution` (requires `candidates.minItems: 2`, all `isDraft: false`, `pr: null`).

Schema change is **additive** — every existing valid payload continues to validate.

---

## Test-surface impact

- `packages/cockpit/src/__tests__/gh-wrapper.test.ts` — the four existing `resolveIssueToPRRef` cases rewrite around the discriminated union. Sixteen new cases seed the per-tier decision matrix (four rows × four tiers-with-fall-through cases each).
- `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` — the `resolveIssueToPRRef` fake stub upgrades. New cases: sniplink SC-001 fixture, single-candidate draft, multi-candidate draft, closing-refs ambiguity, branch-name ambiguity, pr-body ambiguity, `resolved PR #N via <linkMethod>` log snapshot.
- `packages/generacy/src/cli/commands/cockpit/__tests__/context.implementation-review.test.ts` — three new cases (`pr-is-draft`, `ambiguous`, `unresolved` each → `CockpitExit(3, …)` with tier + candidates in the message).
- Cross-cutting: any test that currently stubs `resolveIssueToPRRef` to return `null` or a `PullRequestRef` upgrades to `{ kind: 'unresolved' }` or `{ kind: 'resolved', ref, linkMethod: 'closing-refs' }`.

---

## Relationships & flow

```
                CLI invocation
                       │
                       ▼
              runMerge (merge.ts)
                       │
                       ▼
        gh.resolveIssueToPRRef(repo, issue)
                       │
                       ▼
          ┌────────────┴───────────────┐
          │ Tier 1: closing-refs        │  ─── gh issue view --json closingIssuesReferences
          │   evaluateTier(candidates)  │
          └────────────┬───────────────┘
                       │ null (fall through)
                       ▼
          ┌────────────┴───────────────┐
          │ Tier 2: branch-name         │  ─── gh pr list --search "head:<n>-"
          │   evaluateTier(candidates)  │
          └────────────┬───────────────┘
                       │ null (fall through)
                       ▼
          ┌────────────┴───────────────┐
          │ Tier 3: pr-body             │  ─── gh pr list --search "<n> in:body"
          │   evaluateTier(candidates)  │
          └────────────┬───────────────┘
                       │ null (fall through)
                       ▼
              { kind: 'unresolved' }

  Any tier's result → returned immediately, no fall-through beyond the first tier that produces a decision.

  runMerge switch:
    resolved       → log "resolved PR #N via <linkMethod>", enter existing gate flow
    pr-is-draft    → emit failing-check payload, exit 1, DO NOT call gh pr merge
    ambiguous      → emit failing-check payload, exit 1, DO NOT call gh pr merge
    unresolved     → existing behavior
```
