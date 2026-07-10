# Feature Specification: Found during the cockpit v1

**Branch**: `904-found-during-cockpit-v1` | **Date**: 2026-07-10 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #48.

## Observed (sniplink P3, auto session transcript)

`generacy cockpit merge --repo christrudelpw/sniplink 9` (and `10`) failed repeatedly with `gh pr merge failed (exit 1): GraphQL: Pull Request is still a draft` — while the actual PRs for those issues were unambiguously ready:

```
PR#23 draft=false branch=009-phase-3-polish-delivery closes=[9]   (mergeable, validated, review-approved)
PR#21 draft=false branch=010-phase-3-polish-delivery closes=[10]  (MERGEABLE/CLEAN, validated, review-approved)
PR#22/24/25 draft=true  (sibling issues #11/#13/#12, still in flight)
```

The verb is resolving the issue to a **draft sibling PR** instead of the issue's own PR. Corroborating evidence: invoked with a bogus ref (`#21`, actually a PR number — see companion agency finding), the resolver reported `{"status":"red","reason":"missing-label","pr":{"number":25}...}` — it linked "issue 21" to PR #25, an unrelated draft. The failure emerged only in P3, where PR bodies cross-reference sibling issues ("depends on #9", "after #10 merges"), which implicates the `pr-body` mention-scan link method: multiple PRs mention the issue, and the resolver picks a wrong candidate. Meanwhile GitHub's authoritative link — `closingIssuesReferences` — is populated, unique, and correct for every PR in the repo.

Two aggravating sub-defects:
- **The error never names the PR it resolved.** `gh pr merge failed: still a draft` with no PR number forced the operator/session to reverse-engineer the target from a separate bogus-ref run. Every merge action must log the resolved PR number and how it was resolved (`linkMethod`).
- **Draft PRs are ever considered candidates at all.** A draft cannot be merged; a resolver whose output feeds `gh pr merge` should treat drafts as non-candidates (or last-resort with a loud warning).

## Fix — resolution precedence, deterministic and loud

1. `closingIssuesReferences` (GitHub's Development link) — if exactly one open PR closes the issue, that's the answer, full stop. (In this repo it was unique and correct for all five PRs.)
2. Head-branch match (`NNN-*` feature-branch naming) as the fallback when closing refs are absent.
3. `pr-body` mention-scan only as a last resort, **excluding drafts**, and if more than one candidate survives: fail loud listing the candidates — never merge a guess. (Invariant: merge is the one irreversible verb in the cockpit; ambiguity is an error, not a coin flip.)
4. Always log/emit `resolved PR #N via <method>` on both success and failure paths.

Check the shared resolver: the `pr-body` linkMethod is also used by `PrFeedbackMonitorService` ("Linked PR #14 to issue #4 via pr-body") — if the same ambiguity exists there, feedback could attach to the wrong PR once sibling bodies cross-reference; the precedence fix should land in the shared link logic, not merge-only.

## Regression tests

- Fixture: issue with one closing-ref PR + two sibling drafts whose bodies mention the issue → resolves to the closing-ref PR.
- No closing ref, branch-name match exists → branch match wins over body mentions.
- Body-mention-only with two non-draft candidates → loud failure listing both, exit non-zero, no merge attempted.
- Draft-only candidates → loud failure ("only draft PRs reference this issue"), no merge attempted.
- Failure paths include the resolved PR number + linkMethod in output.


## User Stories

### US1: Merge resolves to the right PR, or refuses loud

**As an** auto-mode operator (or a developer running `generacy cockpit merge <issue-ref>` by hand),
**I want** the resolver behind `merge` (and every other cockpit verb that shares it) to pick the *authoritatively* linked PR for the issue and, when authority is absent or ambiguous, refuse loudly with the resolved PR number and linkMethod visible,
**So that** the cockpit's one irreversible verb never silently targets a draft sibling, a stale attempt, or a coincidentally-mentioned PR — and when it does refuse, I can see exactly which PR it looked at and why.

**Acceptance Criteria**:
- [ ] For every open issue with exactly one open non-draft PR in `closingIssuesReferences`, the resolver returns that PR with `linkMethod: 'closing-refs'` — no fall-through, no sibling contamination (repro: the sniplink incident's issues #9 and #10).
- [ ] Draft PRs are never returned by the resolver as the *chosen* candidate. If the only PRs pointing at an issue are drafts, the resolver returns `{ kind: 'pr-is-draft', candidates: [...] }` — not a `null`, not a resolved-draft that `gh pr merge` will reject downstream with a nameless error.
- [ ] Every merge attempt — success or failure — prints and emits `resolved PR #N via <linkMethod>` (or the ambiguous-candidate list) so an operator never has to reverse-engineer the target from a second bogus-ref run.
- [ ] Ambiguity at any tier (>1 non-draft closing-ref, >1 non-draft branch-name match, >1 non-draft body mention) yields a discriminated `{ kind: 'ambiguous', candidates: [...], linkMethod }` result — merge exits non-zero without touching GitHub.
- [ ] The precedence fix lives in the *shared* resolver, so `PrFeedbackMonitorService` (which today logs `Linked PR #N to issue #M via pr-body`) picks up the same guarantees and cannot attach feedback to a wrong sibling PR.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `resolveIssueToPRRef` MUST first query `closingIssuesReferences` (GitHub's Development link). Filter to open non-drafts. If exactly one remains → return `{ kind: 'resolved', ref, linkMethod: 'closing-refs' }`. If ≥2 open non-drafts remain → return `{ kind: 'ambiguous', candidates, linkMethod: 'closing-refs' }` (do NOT fall through). If 0 open non-drafts but ≥1 open drafts → return `{ kind: 'pr-is-draft', candidates, linkMethod: 'closing-refs' }` (do NOT fall through). If 0 open PRs total → fall through to FR-002. | P1 | Q1-B. Closing-refs is GitHub's authoritative link and was correct for all five PRs in the sniplink incident. Falling through from an ambiguous strong signal to a weaker one converts "two good candidates" into "guess from worse data." |
| FR-002 | Same shape as FR-001 against head-branch match `^<issue>-` (feature-branch naming). Filter open non-drafts. Exactly-one → `'resolved' via 'branch-name'`. ≥2 → `'ambiguous' via 'branch-name'` (no fall-through). Only drafts → `'pr-is-draft' via 'branch-name'` (no fall-through). Zero → fall through to FR-003. | P1 | Q2-B, symmetric with FR-001. |
| FR-003 | Same shape as FR-001/FR-002 against `pr-body` mention-scan (open PRs whose body references the issue). Filter open non-drafts. Exactly-one → `'resolved' via 'pr-body'`. ≥2 → `'ambiguous' via 'pr-body'`. Only drafts → `'pr-is-draft' via 'pr-body'`. Zero → return `{ kind: 'unresolved' }`. | P1 | This is the tier where the sniplink incident manifested — P3 phase PRs cross-reference sibling issues. Drafts must be excluded here specifically, not "considered but flagged." |
| FR-004 | Every merge attempt MUST log/emit `resolved PR #N via <linkMethod>` on the happy path *before* invoking `gh pr merge`, so the operator can see the target *even when the subsequent merge call fails*. The same field lands in stdout JSON as `pr: { number, url, linkMethod }`. | P1 | Bug: the incident's `gh pr merge failed: still a draft` printed no PR number, forcing reverse-engineering. Log line lands before the merge call so a subsequent failure doesn't erase the evidence. |
| FR-005 | When `resolveIssueToPRRef` returns `{ kind: 'pr-is-draft', candidates, linkMethod }`, `runMerge` MUST NOT call `gh pr merge`. It emits a failing-check payload with `reason: 'pr-is-draft'` and top-level `linkMethod`, flattened per FR-008 (single candidate → `pr: { number, url, linkMethod }`; multi-candidate → `candidates: [...]`). Exit non-zero. Single-candidate and multi-candidate draft cases both use `'pr-is-draft'`. | P1 | Q3-C generalized. Operator action for one draft and several drafts is identical: the work isn't ready. |
| FR-006 | When `resolveIssueToPRRef` returns `{ kind: 'ambiguous', candidates, linkMethod }`, `runMerge` MUST NOT call `gh pr merge`. It emits a failing-check payload with `reason: 'ambiguous-resolution'`, `candidates: [{ number, url, isDraft, headRefName }]`, and top-level `linkMethod` naming which tier produced the set. Exit non-zero. | P1 | Q3-C generalized. `linkMethod` disambiguates closing-refs / branch-name / pr-body ambiguity without multiplying enum values per tier. |
| FR-007 | The precedence fix (FR-001..FR-003) MUST live in the shared resolver, not in `runMerge`. `PrFeedbackMonitorService` and any other current or future consumer of `resolveIssueToPRRef` MUST get the same guarantees. | P1 | Reasoning in the observation: same ambiguity that misdirected merge could misdirect PR-feedback attachment. |
| FR-008 | The failing-check payload's `pr` field MUST be shaped `{ number, url, linkMethod } \| null` for single-PR outcomes (success, `missing-label`, `checks-failing`, single-candidate `pr-is-draft`). For multi-candidate ambiguous / draft outcomes, `pr` is `null` and the payload instead carries `candidates: [{ number, url, isDraft, headRefName }]` plus top-level `linkMethod`. | P1 | Q4-D. Keeps the `pr` key name (no rename churn); ambiguous responses carry the full candidate set so downstream consumers don't second-query. |
| FR-009 | `IGh.resolveIssueToPRRef` return type MUST become a discriminated union: `\| { kind: 'resolved'; ref: PullRequestRef; linkMethod } \| { kind: 'ambiguous'; candidates: PullRequestRef[]; linkMethod } \| { kind: 'pr-is-draft'; candidates: PullRequestRef[]; linkMethod } \| { kind: 'unresolved' }`. `null` retires. | P1 | Q5-B. Ambiguity evidence flows back from the single resolution pass; no TOCTOU re-derivation, no exceptions-as-control-flow. Aligns with #902 Q4 and #889 Q2-D. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Sniplink-incident regression fixture (one closing-ref PR + two sibling drafts whose bodies mention the issue) resolves to the closing-ref PR. | 100% (deterministic) | Regression test in the resolver's test file — reproduces sniplink #9/#10 shape, asserts `{ kind: 'resolved', linkMethod: 'closing-refs' }`. |
| SC-002 | Draft-only candidates yield a `pr-is-draft` outcome with the full draft list; `gh pr merge` is never invoked. | 100% | Regression test with mocked `gh` — asserts `runMerge` never spawns `gh pr merge` and payload carries `reason: 'pr-is-draft'` + `candidates[]`. |
| SC-003 | Multi-candidate ambiguity at any tier (closing-refs / branch-name / pr-body) yields `reason: 'ambiguous-resolution'` with the correct `linkMethod` naming the tier. | 100% | Three regression tests, one per tier, each seeding ≥2 open non-draft candidates. |
| SC-004 | Every success path prints `resolved PR #N via <linkMethod>` before invoking `gh pr merge`; every failure path's stdout JSON carries the same `linkMethod` (or `candidates[]` for the multi-candidate kinds). | 100% | Snapshot test on stdout/log output for success + each failure kind. |
| SC-005 | `PrFeedbackMonitorService` uses the same resolver decision (no independent code path for pr-body mention-scan). | 1 shared code path | Code-search assertion: only one implementation of the resolver; feedback service imports it. |

## Assumptions

1. `gh pr view --json closingIssuesReferences` remains the canonical GraphQL surface for the Development link (as used in cluster-base's `gh` today). No new API access required.
2. Draft state (`isDraft` in GraphQL, `draft` on `PullRequestRef`) is always populated on the PR objects we fetch — no "unknown draft" state to defend against.
3. The three tiers (closing-refs → branch-name → pr-body) are exhaustive for v1. Future tiers (labels, commit-trailer, etc.) can be added by appending to the fall-through chain without changing the discriminated-union shape.
4. Callers other than `runMerge` — notably `PrFeedbackMonitorService` — will adopt the new return type shape as part of the same change (single-atomic edit to the shared resolver + its consumers).
5. Auto-mode's finding recorder in `tetrad-development` reads `reason` and `linkMethod` off the payload directly; the enum additions (`'pr-is-draft'`, `'ambiguous-resolution'`) are additive, so existing consumers of `'unresolved' | 'missing-label' | 'checks-failing'` do not break.

## Out of Scope

- Auto-mode's *recovery* behavior when it encounters `pr-is-draft` or `ambiguous-resolution` (retry cadence, escalation to human, etc.) — that's tetrad-development-side and lives in a separate spec.
- Any change to `gh pr merge` itself or its retry logic. This spec is the pre-flight resolver + payload shape; the merge call itself is unchanged.
- New link tiers beyond closing-refs / branch-name / pr-body.
- Cross-repo issue → PR resolution (e.g. issue in repo A closed by PR in repo B). Both today and after this fix, the resolver operates within one repo.
- Removing the `pr-body` tier entirely. The incident argues for demoting it (drafts excluded, ambiguity is fatal), not deleting it — some workflows still rely on body mentions when closing-refs isn't populated.

---

*Generated by speckit*
