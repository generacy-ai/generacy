# Research: deterministic issue→PR resolver

**Feature**: #904 — resolver precedence + draft rejection + loud ambiguity
**Branch**: `904-found-during-cockpit-v1`
**Date**: 2026-07-10
**Phase**: 0 — technology & pattern decisions

---

## Decision 1: Which `gh` query for Tier 1 (closing-refs)?

**Options considered**:
- **A**: Keep the current `gh pr list --repo <r> --search "linked:<n>" --state open --limit 1` (the query at `wrapper.ts:679-691`).
- **B**: `gh issue view <n> --repo <r> --json closingIssuesReferences,…` — the same query already used as the fallback branch (line 719-728).
- **C**: `gh api graphql -f query='{ repository(...) { issue(...) { closingIssuesReferences(first: 100) { nodes { number, url, isDraft, headRefName, state } } } } }'`.

**Chosen**: **B**. `closingIssuesReferences` is GitHub's authoritative Development link — the same signal the web UI's "Development" sidebar renders. The sniplink observation confirms it was correct and unique for all five PRs in the incident. Option A's `linked:` search qualifier is documented as "closing-refs plus title/body cross-references" and is exactly the fuzzy signal that misdirected the resolver. Option C would give slightly richer draft/state fields in one round trip but adds a graphql dependency and CI mocking burden the plain JSON view avoids.

**Rationale**:
- `gh issue view --json closingIssuesReferences` already ships `number, url, state, isDraft, headRefName` on each returned reference (verified against the fallback branch's schema in `wrapper.ts:738-753`).
- Zero new gh capabilities — same subcommand, same JSON schema, we're just moving it from the fallback to the primary tier.
- The current `--limit 1` on the primary search is the exact bug: it collapses ambiguity to a silent pick. Removing it (moving to the view-based tier) preserves the whole candidate set.

**Alternatives rejected**:
- Option A: keeps the very query that produced the incident.
- Option C: gratuitous complexity; adds a graphql schema surface the codebase doesn't otherwise use.

---

## Decision 2: Which `gh` query for Tier 2 (branch-name)?

**Options considered**:
- **A**: `gh pr list --repo <r> --state open --search "head:<issue>-" --json …` — GitHub's search qualifier syntax.
- **B**: `gh pr list --repo <r> --state open --json headRefName,… --limit 100` and filter client-side for `headRefName.startsWith(<issue>-)`.
- **C**: `gh api repos/<r>/pulls?head=<r-owner>:<issue>-*` — REST with wildcard head match (**not supported** — the REST API only accepts exact branch names).

**Chosen**: **A** — `gh pr list --search "head:<issue>-"`. The `head:` qualifier on the search API does prefix matching in the way we need.

**Rationale**:
- Server-side filtering scales with repo size; B does a `--limit 100` scan that has to be raised for large repos.
- The `head:` qualifier is documented on the GitHub search API and stable.
- Matches the feature-branch naming already used everywhere else in the codebase (`NNN-<slug>`).

**Alternatives rejected**:
- B: fragile at scale, and `--limit 100` is a silent truncation that could re-introduce the same class of bug that ambiguity-collapse caused at Tier 3.
- C: REST `?head=` doesn't accept wildcards. Verified against the GitHub REST docs.

---

## Decision 3: Which `gh` query for Tier 3 (pr-body mention-scan)?

**Options considered**:
- **A**: `gh pr list --repo <r> --state open --search "<issue> in:body" --json …` — full-text search restricted to the body.
- **B**: `gh pr list --repo <r> --state open --json body,… --limit 200` and regex-match `#<issue>\b` client-side.
- **C**: Only match closing keywords (`Closes #<n>`, `Fixes #<n>`, `Resolves #<n>`) — the same set `PrLinker.closingRegex()` uses.

**Chosen**: **A** — server-side search restricted to `in:body`.

**Rationale**:
- Mirrors GitHub's own "issue mentions" surface — same signal an operator would eyeball.
- Server-side; no `--limit` truncation risk.
- C would tighten Tier 3 to the closing-keyword subset, but the sniplink incident happened because PR bodies said "depends on #9" — a non-closing mention. If we filter that out at Tier 3, the mention still exists in reality and we've just moved the failure mode from "resolver picks wrong PR" to "resolver returns unresolved when a human clearly linked". Better to include mentions and force loud ambiguity.

**Alternatives rejected**:
- B: `--limit N` truncation risk, and doing the regex client-side loses the GraphQL server's tokenizer (which handles code blocks, quoted mentions, etc. correctly).
- C: too narrow. See rationale above.

---

## Decision 4: Return-type shape — discriminated union vs sentinel `null`

**Options considered** (from clarifications Q5):
- **A**: Add `linkMethod` + optional `candidates` to `PullRequestRef`; return `null` on ambiguity, let caller re-derive.
- **B**: Discriminated union `{ kind: 'resolved' | 'ambiguous' | 'pr-is-draft' | 'unresolved'; … }`.
- **C**: Keep `PullRequestRef | null`; throw typed errors for the loud paths.
- **D**: Split into two methods (`resolveIssueToPR` + `describeIssuePrCandidates`).

**Chosen**: **B**. Locked in by clarification Q5-B.

**Rationale** (per clarification):
- A and D both TOCTOU-flawed — `runMerge` re-deriving candidates after a `null` means the ambiguity payload is computed from a *second* query that can disagree with what the resolver saw.
- C is exceptions-as-control-flow — already rejected for the same reason in #889 (Q2-D) and #902 (Q4). One wrapping catch and the loud failure degrades to a generic one.
- B aligns with the architectural precedent set by #902 and #889 and threads the evidence from the single resolution pass all the way to the failing-check payload.

**Alternatives rejected**: A, C, D — all fail the "single resolution pass carries all evidence" test.

---

## Decision 5: FailingCheckPayload shape for reporting the resolved PR + linkMethod

**Options considered** (from clarifications Q4):
- **A**: Extend the existing `pr` field to `pr: { number, url, linkMethod } | null`.
- **B**: Keep `pr: { number, url } | null`; add a sibling top-level `linkMethod`.
- **C**: Replace `pr` with `resolvedPr: { number, url, linkMethod } | null`; deprecate `pr`.
- **D**: On ambiguous failures, use `candidates: Array<{ number, url, isDraft, headRefName }>` + top-level `linkMethod`; on single-PR outcomes, use A.

**Chosen**: **D**. Locked in by clarification Q4-D.

**Rationale**:
- Single-PR outcomes (success, `missing-label`, `checks-failing`, single-candidate `pr-is-draft`) keep the existing `pr` key name — no downstream rename churn (`tetrad-development` finding recorder reads `pr.number`).
- Multi-candidate ambiguous/only-drafts paths carry the full candidate set on `candidates` plus a top-level `linkMethod` — downstream consumers don't second-query GitHub to see what the resolver considered.
- The top-level `linkMethod` on multi-candidate paths is redundant-but-explicit: it disambiguates which tier produced the set without having to inspect the candidate PR bodies.

**Alternatives rejected**: A, B, C — see clarifications Q4 for full reasoning.

---

## Decision 6: New `reason` enum values

**Options considered** (from clarifications Q3):
- **A**: Three new variants (`pr-is-draft`, `ambiguous-body-mentions`, `only-drafts-mention`).
- **B**: Single `unmergeable` variant with a `subReason` field.
- **C**: `pr-is-draft` + a single `ambiguous-resolution`, both carrying `candidates` and `linkMethod`.
- **D**: something else.

**Chosen**: **C, generalized**. Locked in by clarification Q3-C.

**Rationale**:
- Ambiguity can arise at any tier (Q1/Q2 answers both establish this) — tier-specific enum values would multiply with every future tier.
- `linkMethod` already names the tier that produced the candidate set.
- Only-drafts folds into `pr-is-draft` with `candidates[]` — one draft or several, the operator action is identical: the work isn't ready.

**Alternatives rejected**: A (proliferates with tiers), B (nesting for nesting's sake — the payload gets deeper without gaining information), D (nobody proposed one).

---

## Decision 7: Why not fold `resolveIssueToPR` (number-only) into the union too?

**Context**: `GhWrapper` has two issue→PR surfaces:
- `resolveIssueToPR(repo, issueNumber): Promise<number | null>` — used by `status.ts`, `context.test.ts`, etc. Reads only `closedByPullRequestsReferences` from `gh issue view`.
- `resolveIssueToPRRef(repo, issue): Promise<PullRequestRef | null>` — used by `merge.ts:85`, `context.ts:266`. Reads `state, isDraft, headRefName`.

**Chosen**: **Leave `resolveIssueToPR` alone**. The scope of #904 (FR-009) is `resolveIssueToPRRef` only.

**Rationale**:
- FR-009 explicitly names `resolveIssueToPRRef` as the return-type change.
- `resolveIssueToPR` is number-only and its callers (`status.ts`) don't need draft/tier information — they just want "does this issue have a linked PR at all?".
- Widening `resolveIssueToPR`'s return type is a separate refactor that touches unrelated call sites; bundling it here would balloon the PR without addressing any FR.
- Follow-up: file a smaller issue if the number-only surface should retire in favor of the tiered union.

---

## Decision 8: Where does the `resolved PR #N via <linkMethod>` log line land?

**Context**: FR-004 requires the log line to appear **before** `gh pr merge` is invoked, so that "a subsequent merge call failing doesn't erase the evidence." Location choice:

**Options considered**:
- **A**: Inside `resolveIssueToPRRef` (in `packages/cockpit`) on the `resolved` branch.
- **B**: In `runMerge` (in `packages/generacy`), right after the switch resolves to `resolved`.
- **C**: In both — resolver logs "picked #N via …" for observability + runMerge logs "resolved PR #N via <linkMethod>" for operator UX.

**Chosen**: **B**. The resolver returns the union; the merge command owns the operator-facing log format.

**Rationale**:
- `packages/cockpit`'s resolver has no operator-facing logger — it uses the passed-in `GhWrapperLogger` (structural `warn`-only interface) exclusively for gh CLI failures.
- Adding logger threading through `packages/cockpit` for a merge-specific status line is scope creep and couples the resolver to the merge UX. The union's `linkMethod` field is enough for callers to render their own log lines (`context.ts` will render a different phrasing on the review-context path).
- FR-004's "before `gh pr merge`" constraint is a `runMerge` invariant: as long as `runMerge` emits its log line inside the `case 'resolved':` branch above `await gh.mergePullRequest(...)`, the constraint is satisfied.

**Alternatives rejected**: A (couples resolver to merge UX), C (double logging noise).

---

## Decision 9: Sniplink regression fixture — shape of the `MockGhWrapper` seed

**Context**: SC-001 requires a regression fixture that reproduces the sniplink #9/#10 shape.

**Chosen fixture shape** (for `gh-wrapper.test.ts` and `merge.test.ts`):

- Issue #9 with `closingIssuesReferences: [PR#23]` (open, non-draft, `headRefName: '009-phase-3-polish-delivery'`).
- Tier 3 body-mention query would return `[PR#23, PR#22 (draft), PR#24 (draft), PR#25 (draft)]` — but the fixture asserts Tier 1 resolves before Tier 3 is ever queried.
- Assertion: `{ kind: 'resolved', ref: {number: 23, …}, linkMethod: 'closing-refs' }` and the Tier 2 / Tier 3 `gh` calls are NEVER made (spy on the runner call count).

**Rationale**: reproduces the incident's exact shape (unique closing-ref + sibling drafts mentioning the issue) and proves both (a) the resolver picks the closing-ref PR and (b) the fall-through short-circuits at Tier 1.

---

## Decision 10: Order of ambiguity check inside a tier — filter drafts before or after counting?

**Chosen**: **Filter drafts first, then count**. (Per clarifications Q1-B and Q2-B, applied identically at all three tiers.)

**Rationale**:
- Q1-B rationale carried forward verbatim: "a draft is not a merge candidate by definition — it cannot be merged, so its presence is never disambiguating information."
- Filtering after would let an abandoned draft attempt on `NNN-first-try` block a live `NNN-do-it-properly` non-draft — the exact scenario Q2 rejected.

**Implementation**: `candidates.filter(p => !p.isDraft)` at each tier before the exactly-one / ≥2 / 0-non-drafts branching. If the post-filter count is 0 AND the pre-filter list contained drafts, that's the `pr-is-draft` signal (no fall-through). If 0 total, fall through.

---

## Key references

- `packages/cockpit/src/gh/wrapper.ts:674-770` — current `resolveIssueToPRRef` implementation being replaced.
- `packages/generacy/src/cli/commands/cockpit/merge.ts:81-239` — current `runMerge`; will gain three new switch branches.
- `packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts` — current failing-check payload builder; will grow two new reasons + candidate/linkMethod fields.
- `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json` — JSON Schema referenced from `merge.test.ts:19-27`; must be extended to accept the new reasons and fields.
- `packages/orchestrator/src/worker/pr-linker.ts` — the PR→issue direction resolver used by `PrFeedbackMonitorService`. Cross-referenced in `plan.md` §"Not touched" — a different query direction from `resolveIssueToPRRef` and not required by any FR.
- Clarifications Q1..Q5 in `clarifications.md` — every architectural decision above traces back to a Q&A pair.
