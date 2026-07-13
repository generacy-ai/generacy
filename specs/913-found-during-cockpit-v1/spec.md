# Feature Specification: cockpit merge — resilient tier-1 resolver against gh CLI shape drift

**Branch**: `913-found-during-cockpit-v1` | **Date**: 2026-07-11 | **Status**: Draft | **Issue**: [#913](https://github.com/generacy-ai/generacy/issues/913)

## Summary

`generacy cockpit merge`'s tier-1 issue→PR resolver (added in #904) parses `gh issue view --json closedByPullRequestsReferences` output and hard-requires `state` and `headRefName` on every reference. gh 2.96.0 (2026-07-02) narrowed that serializer to `{id, number, repository, url}` for GraphQL-backed fields, so the zod parse now fails ("expected string, received undefined") on every invocation, taking down the sanctioned merge path with no bypass. Operator-authorized raw `gh pr merge` was the only recovery during the tetrad-development#92 snappoll run (11 merges).

This spec covers three coupled fixes: decouple resolution from gh's `--json` shape (fetch the required fields explicitly), add a `--pr <number>` escape hatch that preserves safety preconditions, and self-identify version-skew failures by echoing the gh version in resolver error output.

## Observed (from #913)

- Failing call: `gh issue view <n> --repo <owner/name> --json closedByPullRequestsReferences`
- gh 2.96.0 shape per reference: `{ id, number, repository, url }` (no `state`, no `headRefName`)
- Resolver location: `packages/cockpit/src/gh/wrapper.ts` `queryTier1ClosingRefs` (~line 748), tier-1 branch of `resolveIssueToPRRef`
- Failure mode: `Error: gh resolveIssueToPRRef tier1 JSON shape mismatch: expected string, received undefined`
- Blast radius during observation: every `cockpit merge` invocation for the full auto-mode run; no bypass path existed

## User Stories

### US1: Operator merges an issue against a gh CLI version whose `--json` shape narrowed

**As an** operator running `generacy cockpit merge <issue-ref>`,
**I want** the resolver to succeed regardless of which fields gh 2.96.0's `--json` emits for `closedByPullRequestsReferences`,
**So that** the sanctioned merge path (with `completed:validate` + green-checks preconditions) works without me falling back to raw `gh pr merge`.

**Acceptance Criteria**:
- [ ] `cockpit merge <ref>` succeeds against gh 2.96.0 output where `closedByPullRequestsReferences[]` entries only carry `{id, number, repository, url}`.
- [ ] `cockpit merge <ref>` still succeeds against the prior gh shape (2.95.x and earlier) that carries `state` + `headRefName` inline.
- [ ] Neither shape's success path silently downgrades safety: `completed:validate` and check classification still gate the merge exactly as they did in #904.

### US2: Operator recovers when the resolver is down entirely

**As an** operator whose resolver is broken by a future gh serializer change (or any transient upstream failure),
**I want** to pass the PR number explicitly via `--pr <number>`,
**So that** I can complete the merge under the sanctioned safety preconditions without shell-escaping to raw `gh pr merge`.

**Acceptance Criteria**:
- [ ] `cockpit merge <ref> --pr <number>` skips issue→PR resolution and treats `<number>` as the target PR. `<ref>` remains required as the authorization source for `completed:validate`.
- [ ] `--pr` verifies via the PR's `closingIssuesReferences` that `<number>` declares `<ref>` as a closing issue; mismatch or empty-refs → refuse (exit 3) with guidance to add the Development link.
- [ ] After linkage verification, `--pr` classifies PR state: `MERGED` → idempotent no-op success (exit 0, log `PR already merged, no-op`); `CLOSED`-unmerged → refuse (exit 3, `PR is closed without merge`); `OPEN` → proceed.
- [ ] `--pr` still enforces the merge preconditions: issue carries `completed:validate`, PR checks classify as green per the classifier used today.
- [ ] `--pr` refuses (non-zero exit, exit-3 refusal semantics) when any precondition is unmet — refusal message names the failing gate. Gate-refusal order: linkage → CLOSED-unmerged state → `completed:validate` → check-classification. It never bypasses safety.
- [ ] `--pr` accepts a bare integer. Non-integer / non-positive values are argument errors (exit 2).

### US3: Operator diagnoses a resolver failure without transcript hunting

**As an** operator triaging a resolver failure in `cockpit merge`,
**I want** the error output to name the gh version and include the raw payload excerpt that failed to parse,
**So that** version-skew failures self-identify (versus me having to reproduce and inspect `gh --version` + raw JSON by hand).

**Acceptance Criteria**:
- [ ] Zod parse-failure error message includes the output of `gh --version` (first line) and up to 512 chars of the offending payload.
- [ ] Exit is non-zero on parse failure (unchanged from today).
- [ ] Version capture failures degrade cleanly (log `gh version: unknown` rather than masking the original parse error).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `queryTier1ClosingRefs` MUST NOT require `state`/`headRefName`/`isDraft` inline on `closedByPullRequestsReferences[]` entries. | P1 | Root cause of the outage. |
| FR-002 | The tier-1 resolver MUST obtain each PR's `state`, `headRefName`, and `isDraft` via `gh api graphql` with an explicit `closedByPullRequestsReferences(...) { nodes { number state headRefName isDraft url } }` selection set. Per-PR `gh pr view --json` is NOT an acceptable substitute — it re-anchors on the same `--json` serializer contract this fix exists to escape. | P1 | Clarified Batch 1 Q5-B: single call regardless of PR count; GraphQL schema is versioned and deprecation-cycled while `--json` shape drifts silently; also dissolves the partial-failure axis in FR-002a. |
| FR-002a | On failure of the FR-002 `gh api graphql` call, the resolver MUST retry once with a 1s backoff. If the retry also fails, the resolver MUST hard-fail (bubble the error, exit 1) — it MUST NOT fall through to tier-2 (branch search), MUST NOT filter to a "successful subset" of PRs, and MUST NOT downgrade the failure to a warning. | P1 | Clarified Batch 1 Q4-D: falling through to branch-search when we *know* closing refs exist but couldn't read their state risks selecting a different PR; filtering admits silent-wrong outcomes; `--pr` is the sanctioned resolver-down escape hatch. |
| FR-003 | The tier-1 resolver MUST continue to filter to `state === 'OPEN'` before returning refs to the merge caller (behavior parity with today). | P1 | Preserves #904 semantics. |
| FR-004 | The tier-1 resolver MUST tolerate the gh 2.96.0 minimal shape `{id, number, repository, url}` on the initial `gh issue view` response — `number` (or `url` as fallback for number extraction, matching the sibling `parseResolveIssueToPr` pattern in `wrapper.ts:478-520`) is the only required field. | P1 | |
| FR-005 | `cockpit merge <ref>` MUST accept an optional `--pr <number>` flag. When present, the tier-1/2/3 resolution chain is skipped entirely; `<number>` is the target PR. `<ref>` remains required (it is the issue whose `completed:validate` label authorizes the merge). | P1 | Escape hatch for future resolver-down scenarios. Clarified Batch 1 Q1-B: `<ref>` is the authorization source, not derived from the PR. |
| FR-006 | `--pr <number>` MUST fetch the PR detail via `gh api graphql` selecting `{ state, headRefName, isDraft, mergeStateStatus, checks, labels, closingIssuesReferences { nodes { number, repository { nameWithOwner } } } }` before merging. `closingIssuesReferences` on the PR (not `closedByPullRequestsReferences` on the issue) is the linkage source for FR-006a. | P1 | Same GraphQL selection-set discipline as FR-002 — the escape hatch and its guard ride the same fixed path. |
| FR-006a | `--pr <number>` MUST verify that `<number>` declares `<ref>` as a closing issue: iterate the PR's `closingIssuesReferences.nodes` and require at least one node whose `(repository.nameWithOwner, number)` matches `<ref>`. On mismatch, or when the PR declares no closing issue references at all, `--pr` MUST refuse (exit 3) with a message that (a) names the mismatch or empty-refs condition and (b) suggests adding the issue via the PR's Development sidebar link. | P1 | Clarified Batch 1 Q1-B: linkage verification runs BEFORE the state check in FR-006b so that a typo'd `--pr` at a random merged PR exits 3 on mismatch, never exits 0 as a no-op. Empty refs → still refuse; do not silently succeed. |
| FR-006b | After FR-006a linkage verification succeeds, `--pr <number>` MUST classify the PR by state: `OPEN` → proceed to precondition checks; `MERGED` → idempotent no-op success (exit 0, log `PR already merged, no-op`); `CLOSED` (unmerged) → refuse (exit 3, `PR is closed without merge`). | P1 | Clarified Batch 1 Q3-B: convergent verb — succeed when goal state already holds so auto-mode retries after a transient failure (gh timing out *after* the merge landed) don't spawn spurious escalations. Q1-B's linkage guard makes the idempotent path safe against operator-typo confusion. |
| FR-007 | `--pr <number>` MUST enforce the same `completed:validate` issue-label precondition (checked on `<ref>`, per FR-005) and the same check-classification gate as the resolver-driven path. | P1 | Bypasses resolution, never safety. |
| FR-008 | `--pr <number>` MUST refuse (non-zero exit, message names the unmet precondition) when preconditions fail; it MUST NOT force-merge. Refusal ordering: (1) FR-006a linkage, (2) FR-006b non-OPEN state (CLOSED-unmerged branch), (3) FR-007 `completed:validate` on `<ref>`, (4) FR-007 check-classification gate. First failing gate exits 3 with a message that names it. | P1 | Exit 3 refusal semantics per cockpit convention. Ordering documented so operators reading the message know which gate tripped. |
| FR-009 | On parse failure in `queryTier1ClosingRefs`, the thrown error message MUST include the gh CLI version (from `gh --version` first line) and the first 512 chars of the raw payload that failed to parse. | P2 | Self-identifying version-skew failure. Clarified Batch 1 Q2-B: 512 fits 2–3 complete reference elements (each ~120–180 chars in the minimal shape) so the missing-keys drift the diagnostic exists to surface is visible without mid-element truncation, without over-padding for many-PR fidelity nobody needs. |
| FR-010 | Version-capture failure (e.g., `gh --version` returns non-zero) MUST NOT mask the original parse error — the wrapper substitutes `gh version: unknown` and re-raises with the parse error retained. | P2 | Defense-in-depth. |
| FR-011 | Regression fixture: an integration or unit test MUST reproduce the gh 2.96.0 minimal-shape response and assert the resolver succeeds without inline `state`/`headRefName`. | P1 | Prevents re-regression. |
| FR-012 | Regression fixture: a unit test MUST assert that `--pr <number>` refuses when `completed:validate` is missing and merges when preconditions hold. | P1 | Prevents safety-bypass regression on the escape hatch. |
| FR-012a | Regression fixture: a unit test MUST assert that `--pr <number>` refuses (exit 3) when the PR's `closingIssuesReferences` does not include `<ref>`, and refuses (exit 3) when the PR's `closingIssuesReferences` is empty. | P1 | Prevents FR-006a regression. |
| FR-012b | Regression fixture: a unit test MUST assert that `--pr <number>` exits 0 as an idempotent no-op when the PR is MERGED (with linkage verified) and exits 3 when the PR is CLOSED (unmerged, with linkage verified). | P1 | Prevents FR-006b regression. |
| FR-012c | Regression fixture: a unit test MUST assert that FR-002's `gh api graphql` failure is retried exactly once with a 1s backoff and, on continued failure, exits 1 without falling through to tier-2. | P1 | Prevents FR-002a regression — the resolver-down escape is `--pr`, not silent tier-2 substitution. |
| FR-013 | Regression fixture: a unit test MUST assert that parse-failure error messages include the gh version string. | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `cockpit merge` succeeds against gh 2.96.0 | 100% success rate for well-formed issues (`completed:validate` + green checks + open PR) | Integration test using recorded 2.96.0 shape fixture |
| SC-002 | Prior gh versions (2.95.x) still work | 0% regression against pre-existing fixtures | Existing test suite for `queryTier1ClosingRefs` passes unchanged |
| SC-003 | `--pr` override merges under preconditions | 100% success rate when `completed:validate` + green checks hold for the named PR | Unit test with mocked GhWrapper |
| SC-004 | `--pr` override refuses without preconditions | 100% refusal (non-zero exit, no merge call) when `completed:validate` missing OR checks red | Unit test with mocked GhWrapper |
| SC-005 | Parse-failure diagnostic includes gh version | Error message contains `gh version:` substring for parse failures | Unit test asserting error message shape |
| SC-006 | No operator falls back to raw `gh pr merge` for gh-version-skew reasons | 0 occurrences in the next auto-mode smoke run | Manual verification in the follow-up run to tetrad-development#92 |
| SC-007 | `--pr <number>` refuses on PR/issue mismatch or empty closing refs | 100% refusal (exit 3, linkage message) when `<number>`'s `closingIssuesReferences` does not include `<ref>` or is empty | Unit test with mocked GhWrapper (FR-012a) |
| SC-008 | `--pr <number>` is idempotent on MERGED, refuses CLOSED-unmerged | 100% exit-0 no-op on MERGED (with linkage verified); 100% refusal (exit 3) on CLOSED-unmerged | Unit test with mocked GhWrapper (FR-012b) |
| SC-009 | Tier-1 GraphQL follow-up failure never falls through to tier-2 | 100% of induced FR-002 failures result in exactly 1 retry then exit 1; 0 tier-2 invocations | Unit test with mocked GhWrapper (FR-012c) |

## Assumptions

- **gh CLI serializer is not a stable contract.** #913 is the second time in the cockpit lifecycle a `--json` field-set drift has changed behavior; the fix must not re-introduce the same coupling for the follow-up fields.
- **The GraphQL query is stable** where the `--json` flag serializer is not — `gh api graphql` returns whatever selection set we request. This is the intended long-term coupling.
- **GraphQL is the chosen fetch strategy for FR-002** (per clarification Q5-B). Per-PR `gh pr view --json state,headRefName,isDraft` was considered and rejected: even though those specific fields are first-class REST PR fields, the whole moral of #913 is that gh's `--json` serializer shape is an implicit contract that drifts under us, so re-anchoring the fix on the same contract class is a step backward. GraphQL's schema is versioned and deprecation-cycled; our explicit selection set is an explicit contract.
- **The `closingIssuesReferences` PR-side query is the linkage source for `--pr`** (per Q1-B). It rides the same explicit-GraphQL discipline as FR-002; the hatch and its guard share one fixed path, not the broken `--json` path.
- **`--pr` on MERGED is convergent, not permissive** (per Q3-B). Auto-mode retries after a transient failure (gh timing out *after* the merge landed) would otherwise spawn spurious escalations. The linkage guard (FR-006a) runs first, so a typo'd `--pr` at some random merged PR exits 3 on mismatch, never 0 as a no-op.
- **Tier-1 follow-up failure is abort-once-retried, never fall-through** (per Q4-D). Falling through to tier-2 (branch search) when tier-1 *knows* closing refs exist but couldn't read their state risks selecting a different PR; filtering to a "successful subset" admits silent-wrong outcomes. The architecture already has the right resolver-down story — that's what `--pr` is for.
- **The two other tiers (branch-name search, PR body scan) are unaffected** — they call `gh pr list --search` and `gh pr view --json body` respectively, both of which return per-PR fields directly, not the issue-side `closedByPullRequestsReferences` union that broke.
- **`--pr` is an escape hatch, not a preferred path.** It documents itself as such; the resolver remains the default.
- **The `parseResolveIssueToPr` schema at `wrapper.ts:478-520`** — the sibling function used by non-merge callers — already tolerates the minimal shape (all fields `.optional()`). Only `queryTier1ClosingRefs` needs the fix.
- **Exit codes follow cockpit convention** (0 success, 2 arg-parse, 3 refusal, 1 transport). `--pr` refusal on missing preconditions is exit 3; malformed `--pr` value is exit 2; parse failure inside the resolver bubbles as exit 1 today and stays as exit 1.
- **Existing checkers reused, not re-implemented.** `classifyChecks` (`packages/generacy/src/cli/commands/cockpit/shared/required-checks.ts`) and the `completed:validate` label check remain the authoritative gates for both paths.

## Out of Scope

- Rewriting the tier-2 (branch-name) or tier-3 (PR-body) resolution paths — untouched by #913.
- Adding an override for the `completed:validate` label check or the check classifier — `--pr` bypasses resolution only, never safety (explicit non-goal per #913 fix item 2).
- Broader gh-CLI-shape hardening across every `--json` call in `packages/cockpit/src/gh/wrapper.ts` — this spec fixes the one broken path; a follow-up may audit the rest.
- Version-pinning gh CLI or shipping a bundled gh — orthogonal, out of scope.
- Cloud-side changes — `cockpit merge` is CLI-local; no relay/cloud contract changes.

---

*Generated by speckit*
