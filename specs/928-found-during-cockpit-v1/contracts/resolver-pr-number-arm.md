# Contract: `resolveIssueToPRRef` — `pr-number` arm

## Location

`packages/cockpit/src/gh/wrapper.ts`

## Extended union

```ts
export type PullRequestRefResolution =
  | { kind: 'resolved'; ref: PullRequestRef; linkMethod: LinkMethod }
  | { kind: 'ambiguous'; candidates: PullRequestRef[]; linkMethod: LinkMethod }
  | { kind: 'pr-is-draft'; candidates: PullRequestRef[]; linkMethod: LinkMethod }
  | { kind: 'unresolved' }
  | { kind: 'pr-number' };   // NEW
```

## Semantics

The `pr-number` arm is returned **iff** the resolver's tier-1 pass (`queryTier1ClosingRefs`) determines the requested `<issue>` number is a `PullRequest` node on the GitHub side, not an `Issue` node.

## Invariants

- **I-6**: `kind === 'pr-number'` ⇒ no other fields present. Zero-field variant.
- **I-7**: emitted from tier-1 only. Tiers 2 (branch-name) and 3 (pr-body) do not classify node type.
- **I-8**: when emitted, tiers 2 and 3 are **not** invoked. Falling through to tier-2 with a PR-numbered input would waste round-trips on a query that has no valid answer.

## Implementation surface

Two implementation options, both acceptable — pick whichever produces cleaner failure paths in the tier-1 code:

### Option A — GraphQL `__typename` on `Node.node(id:)`

Extend the tier-1 GraphQL query to resolve the requested number to its GitHub node ID first, then query `__typename`. If `PullRequest`, return `{ kind: 'pr-number' }`. If `Issue`, proceed as today.

### Option B — Catch tier-1's initial `gh issue view <n> --json closedByPullRequestsReferences` error

`gh issue view` on a PR number today emits a distinctive error (something like `gh: could not resolve to an issue`). Tier-1 currently `failIfNonZero`s on that. Modify the check: if the error text indicates a type mismatch (heuristic — the exact string depends on `gh` CLI version, so guard behind a version-tolerant matcher), issue a second GraphQL round-trip against the sibling `PullRequest` type. If the number *is* a valid PR node, return `{ kind: 'pr-number' }`.

Option A is cleaner but requires editing the GraphQL query and its response Zod schema. Option B is more defensive against `gh` CLI version drift and doesn't touch the existing successful-tier-1 path. Both satisfy the contract; the choice is a review-time judgment on which is easier to test.

## Contract test seams

- `packages/cockpit/src/gh/__tests__/wrapper.tier1-shape-drift.test.ts`: new case that stubs a `PullRequest`-node response and asserts `{ kind: 'pr-number' }` — no other fields, no fallthrough to tier-2.
- `packages/cockpit/src/__tests__/gh-wrapper.test.ts` § `resolveIssueToPRRef (#904 — three-tier deterministic resolver)`: add coverage for the new arm parallel to the existing `unresolved`-when-tier-1-empty tests.

## Non-goals

- The arm does **not** carry the input number in its payload. The caller already has it (`issue` argument to `resolveIssueToPRRef`).
- The arm does **not** propose a corrected issue number ("did you mean issue #N?"). Guessing would require reverse-lookup by closing-refs which is expensive; the CLI's guidance copy is the correct place to advise the caller.
