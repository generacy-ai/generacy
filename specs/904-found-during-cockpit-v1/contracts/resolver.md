# Contract: `GhWrapper.resolveIssueToPRRef`

**Feature**: #904
**Interface**: `packages/cockpit/src/gh/wrapper.ts`
**Signature**: `resolveIssueToPRRef(repo: string, issue: number): Promise<PullRequestRefResolution>`

---

## Preconditions

- `repo` is a non-empty `"owner/name"` string. Not validated inside `resolveIssueToPRRef` — malformed values propagate to `gh` and surface as `gh <op> failed` errors.
- `issue` is a positive integer. Same non-validation.
- The `gh` CLI is on PATH and authenticated. Existing runner contract — no change.

## Postconditions

Returns exactly one of:

### `{ kind: 'resolved'; ref: PullRequestRef; linkMethod: LinkMethod }`

- `ref` is a real, open, non-draft PR in `repo`.
- `linkMethod` names the tier that produced the resolution.
- Guaranteed: `ref.state === 'OPEN'` AND `ref.draft === false`.
- No other tier was queried (early-return on first tier that produces a decision).

### `{ kind: 'ambiguous'; candidates: PullRequestRef[]; linkMethod: LinkMethod }`

- `candidates.length >= 2`.
- Every candidate is open and non-draft (drafts were filtered out at the tier before ambiguity was declared).
- `linkMethod` names the tier that produced the set.
- No later tier was queried.

### `{ kind: 'pr-is-draft'; candidates: PullRequestRef[]; linkMethod: LinkMethod }`

- `candidates.length >= 1`.
- Every candidate is open AND has `draft === true`.
- `linkMethod` names the tier at which the only candidates were drafts.
- No later tier was queried.

### `{ kind: 'unresolved' }`

- All three tiers ran and produced no result (no open PRs at closing-refs, no `head:<n>-` branch matches among open PRs, no `<n> in:body` matches among open PRs).

## Ordering guarantees

- **Cheapest-first**: Tier 1 always runs first (piggybacks on the same `gh issue view` we already do for issue metadata). Tier 2 runs only if Tier 1 falls through. Tier 3 runs only if Tier 2 falls through.
- **Early return**: the first tier that produces a decision (any of `resolved`, `ambiguous`, `pr-is-draft`) short-circuits. Subsequent tiers are not queried.
- **No parallelization**: tier queries are strictly sequential.

## Error propagation

- Any `gh` call failing (non-zero exit, malformed JSON, schema mismatch) throws with the existing `gh <op> failed (exit <n>): <stderr>` shape.
- Tier failure does NOT fall through. A failed Tier 1 does NOT silently proceed to Tier 2. Rationale: silently downgrading from an authoritative signal to a weaker one on error is Q5's TOCTOU flaw at query-time.
- Callers of `resolveIssueToPRRef` must `try/catch` gh errors themselves — this contract does not translate them to `unresolved`.

## Invariants (enforced inside the resolver, not caller-checked)

- **I-1**: `kind === 'ambiguous'` ⇒ `candidates.length >= 2` ∧ ∀c ∈ candidates: `c.draft === false`.
- **I-2**: `kind === 'pr-is-draft'` ⇒ `candidates.length >= 1` ∧ ∀c ∈ candidates: `c.draft === true`.
- **I-3**: `kind === 'resolved'` ⇒ `ref.draft === false` ∧ `ref.state === 'OPEN'`.
- **I-4**: `kind === 'unresolved'` ⇒ no other fields present (zero-field variant).
- **I-5**: `linkMethod` is one of `'closing-refs' | 'branch-name' | 'pr-body'` — never `undefined` on the three non-`unresolved` kinds.

---

## Per-tier query contracts

### Tier 1 — `linkMethod: 'closing-refs'`

**gh call**:
```
gh issue view <issue> --repo <repo> --json closingIssuesReferences
```

**Expected JSON shape**:
```json
{ "closingIssuesReferences": [
  { "number": N, "url": "...", "state": "OPEN|CLOSED|MERGED", "isDraft": true|false, "headRefName": "..." }
] }
```

**Post-processing**:
- Deserialize into `PullRequestRef[]`.
- Filter to `state === 'OPEN'` (drop MERGED/CLOSED; they're irrelevant to future merges).
- Apply `evaluateTier(openCandidates, 'closing-refs')`.

### Tier 2 — `linkMethod: 'branch-name'`

**gh call**:
```
gh pr list --repo <repo> --state open --search "head:<issue>-" --json number,url,state,isDraft,headRefName --limit 100
```

**Notes**:
- `--limit 100` is a soft ceiling; if a repo has >100 open PRs matching `head:<issue>-` we have bigger problems than this resolver can fix. The runner's error path surfaces this as `gh pr list failed`.
- The `head:` search qualifier does prefix matching in the GitHub search API. Verified against GitHub docs.

**Post-processing**: same as Tier 1 — deserialize, filter to open, `evaluateTier(candidates, 'branch-name')`.

### Tier 3 — `linkMethod: 'pr-body'`

**gh call**:
```
gh pr list --repo <repo> --state open --search "<issue> in:body" --json number,url,state,isDraft,headRefName --limit 100
```

**Notes**:
- `<issue>` is the raw integer, not `#<issue>`. GitHub's full-text search tokenizes on `#` and would drop it.
- `in:body` scopes the search to bodies only (not title, not comments) — matches the sniplink incident's "PR #22's body says 'depends on #9'" shape.

**Post-processing**: same as Tiers 1/2 — deserialize, filter to open, `evaluateTier(candidates, 'pr-body')`.

---

## `evaluateTier` — the per-tier evaluator

```ts
function evaluateTier(
  candidates: PullRequestRef[],   // open PRs from this tier
  linkMethod: LinkMethod,
): PullRequestRefResolution | null /* null = fall-through */ {
  const nonDrafts = candidates.filter(p => !p.draft);
  if (nonDrafts.length === 1) return { kind: 'resolved',    ref: nonDrafts[0]!, linkMethod };
  if (nonDrafts.length >= 2)  return { kind: 'ambiguous',   candidates: nonDrafts, linkMethod };
  const drafts = candidates.filter(p => p.draft);
  if (drafts.length >= 1)     return { kind: 'pr-is-draft', candidates: drafts, linkMethod };
  return null;
}
```

Applied identically at each tier.

---

## Consumer contracts

### `runMerge` (`packages/generacy/src/cli/commands/cockpit/merge.ts`)

Consumes: all four `kind` values.

- `resolved`: emit `resolved PR #N via <linkMethod>` log line **before** invoking `gh pr merge` (FR-004). Continue existing gate flow. Thread `resolution.linkMethod` into `missing-label` and `checks-failing` payloads.
- `pr-is-draft`: emit `reason: 'pr-is-draft'` payload with `candidates` and top-level `linkMethod`. Exit 1. DO NOT invoke `gh pr merge`.
- `ambiguous`: emit `reason: 'ambiguous-resolution'` payload with `candidates` and top-level `linkMethod`. Exit 1. DO NOT invoke `gh pr merge`.
- `unresolved`: emit `reason: 'unresolved'` payload with `pr: null`. Exit 1. Preserves existing behavior.

### `buildImplementationReviewBundle` (`packages/generacy/src/cli/commands/cockpit/context.ts:259`)

Consumes: all four `kind` values.

- `resolved`: extract `.ref`, use as today.
- `pr-is-draft`: `throw new CockpitExit(3, 'cockpit context: gate refusal: issue X at waiting-for:implementation-review but linked PR #N is a draft (via <linkMethod>)')`. Exit code 3 preserves the existing gate-refusal semantics.
- `ambiguous`: `throw new CockpitExit(3, 'cockpit context: gate refusal: issue X at waiting-for:implementation-review but multiple PRs match via <linkMethod>: #A, #B, …')`.
- `unresolved`: existing `'no linked PR resolved'` message preserved.

---

## Behavioral tests (contract-level)

Traceability to spec acceptance criteria and success metrics:

- **SC-001**: sniplink fixture. Given issue with `closingIssuesReferences: [#23]` and body-mention Tier 3 candidates `[#23, #22 (draft), #24 (draft), #25 (draft)]`, the resolver returns `{ kind: 'resolved', ref: {number: 23}, linkMethod: 'closing-refs' }` and Tier 2/Tier 3 runners are NEVER invoked.
- **SC-002**: draft-only fixture at any tier. Given no closing-refs, no branch-name match, and body-mention Tier 3 candidates all draft, the resolver returns `{ kind: 'pr-is-draft', candidates: [...], linkMethod: 'pr-body' }`. `runMerge` never calls `gh pr merge`.
- **SC-003**: ambiguity at each tier. Three fixtures, one per tier, each seeding ≥2 open non-draft candidates. Each yields `{ kind: 'ambiguous', linkMethod: <tier> }`.
- **SC-004**: log-line + payload snapshot. On the `resolved` path, `logger.info` is called with the exact message `'resolved PR #N via <linkMethod>'` **before** any `mergePullRequest` call. On failure paths, the payload's `linkMethod` matches the resolution's `linkMethod`.
- **SC-005**: code-search assertion. There is exactly one implementation of the tiered issue→PR resolver — in `packages/cockpit/src/gh/wrapper.ts`. `PrLinker` (PR→issue direction, `packages/orchestrator/src/worker/pr-linker.ts`) is a different query direction and is explicitly out of scope.

---

## Backwards compatibility

- **Breaking** (necessarily): the `GhWrapper` interface's `resolveIssueToPRRef` return type changes. Every consumer must update — this PR touches all of them (see plan.md §"Modified — tests (all existing)").
- **Not breaking**: the JSON schema for `FailingCheckPayload` is additive (new reasons + fields, existing valid payloads keep validating).
- **Not breaking**: the older number-only `resolveIssueToPR` surface is untouched (research.md §Decision 7).
